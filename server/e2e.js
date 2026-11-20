#!/usr/bin/env node
/*
 *	End-to-end smoke test for phase 2: real Chromium, real sync server, real nullboard.html.
 *	Zero dependencies - drives Chrome over CDP with Node's built-in WebSocket.
 *
 *	Run: node server/e2e.js
 *	CHROME=/path/to/chrome to override the browser.
 */

'use strict';

const http = require('node:http');
const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const os   = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { start: startSyncServer } = require('./server');

const ROOT   = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');
const TOKEN  = 'e2e-token';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff': 'font/woff' };

let failures = 0;
let checks   = 0;

function check(ok, what, extra)
{
	checks++;
	console.log((ok ? '  ok   ' : '  FAIL ') + what + (ok || extra === undefined ? '' : `  (${JSON.stringify(extra)})`));
	if (! ok) failures++;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/*
 *	the app, served over http so localStorage and cross-origin CORS behave for real
 */
function serveApp()
{
	const server = http.createServer((req, res) => {
		const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));

		if (! file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

		fs.readFile(file, (err, data) => {
			if (err) { res.writeHead(404); return res.end('not found'); }
			res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
			res.end(data);
		});
	});

	return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

/*
 *	minimal CDP client
 */
class Cdp
{
	constructor(ws)
	{
		this.ws = ws;
		this.id = 0;
		this.pending = new Map();

		ws.addEventListener('message', ev => {
			const msg = JSON.parse(ev.data);
			const p = this.pending.get(msg.id);
			if (! p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error.message));
			else           p.resolve(msg.result);
		});
	}

	send(method, params = {})
	{
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	async eval(expression)
	{
		const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (r.exceptionDetails)
			throw new Error('page exception: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
		return r.result.value;
	}
}

async function launchChrome(profile)
{
	const proc = spawn(CHROME, [
		'--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
		'--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
	], { stdio: [ 'ignore', 'ignore', 'pipe' ] });

	const portFile = path.join(profile, 'DevToolsActivePort');

	for (let i = 0; i < 100; i++)
	{
		try
		{
			const lines = (await fsp.readFile(portFile, 'utf8')).split('\n');
			const port = Number(lines[0]);
			if (port) return { proc, port };
		}
		catch (x) { }

		await sleep(100);
	}

	proc.kill();
	throw new Error(`Chrome did not open a debugging port (is ${CHROME} there?)`);
}

async function connect(port)
{
	const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = list.find(t => t.type === 'page');

	const ws = new WebSocket(page.webSocketDebuggerUrl);

	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});

	return new Cdp(ws);
}

/*
 *	server helpers (speaking as "the other user")
 */
function api(base, method, p, body, ifMatch)
{
	const headers = { 'X-Access-Token': TOKEN };
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	if (ifMatch)            headers['If-Match'] = String(ifMatch);

	return fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
		.then(async r => ({ status: r.status, body: await r.text().then(t => t ? JSON.parse(t) : null) }));
}

async function waitFor(fn, timeout = 15000, what = 'condition')
{
	const deadline = Date.now() + timeout;
	let last;

	while (Date.now() < deadline)
	{
		try { last = await fn(); if (last) return last; } catch (x) { last = x.message; }
		await sleep(100);
	}

	throw new Error(`timeout waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/*
 *	the test
 */
async function main()
{
	if (! fs.existsSync(CHROME)) { console.error('no chrome at ' + CHROME); process.exit(2); }

	const dataDir   = await fsp.mkdtemp(path.join(os.tmpdir(), 'nb-e2e-data-'));
	const profile   = await fsp.mkdtemp(path.join(os.tmpdir(), 'nb-e2e-prof-'));
	const profile2  = await fsp.mkdtemp(path.join(os.tmpdir(), 'nb-e2e-prof2-'));

	const syncServer = await startSyncServer({ port: 0, dir: dataDir, token: TOKEN });
	const base       = `http://127.0.0.1:${syncServer.address().port}`;
	const appServer  = await serveApp();
	const appUrl     = `http://127.0.0.1:${appServer.address().port}/nullboard.html`;

	const { proc, port } = await launchChrome(profile);
	const cdp = await connect(port);

	let proc2 = null;

	try
	{
		console.log('\n1. app boots offline');
		await cdp.send('Page.navigate', { url: appUrl });
		await waitFor(() => cdp.eval('window.NB && NB.board ? NB.board.id : 0'), 15000, 'first board');
		check(await cdp.eval('$(".logo .ver").text().length > 0'), 'version is rendered next to the logo',
			await cdp.eval('$(".logo .ver").text()'));
		check(await cdp.eval('$(".config .sync-conf").length == 1'), 'sync settings exist in the config menu');
		check(await cdp.eval('NB.sync.enabled == false'), 'sync is off until configured');

		console.log('\n2. turning sync on pushes the local board');
		await cdp.eval(`
			var conf = NB.storage.getConfig();
			conf.sync.base = ${JSON.stringify(base)};
			conf.sync.auth = ${JSON.stringify(TOKEN)};
			conf.sync.who  = 'browser-a';
			NB.storage.saveConfig();
			NB.sync.start();
		`);

		const index1 = await waitFor(async () => {
			const r = await api(base, 'GET', '/boards');
			return r.status == 200 && r.body.length ? r.body : null;
		}, 15000, 'board to reach the server');

		check(index1.length == 1, 'server has exactly one board', index1);
		check(index1[0].lastEditor == 'browser-a', 'server records the editor name', index1[0].lastEditor);
		check(index1[0].revision == 1, 'first push is revision 1', index1[0].revision);

		const boardId = index1[0].id;

		console.log('\n3. a local edit is pushed');
		await cdp.eval(`
			var $l = $('.wrap .board .list').first();
			addNote($l);
			var $n = $l.find('.note').last();
			$n.find('.edit').val('note from the browser');
			stopEditing($n.find('.edit'), false, false);
		`);

		const index2 = await waitFor(async () => {
			const r = await api(base, 'GET', '/boards');
			return r.body[0].revision > 1 ? r.body[0] : null;
		}, 15000, 'edit to reach the server');

		check(index2.revision == 2, 'edit bumps the server revision', index2.revision);

		const stored = await api(base, 'GET', '/board/' + boardId);
		const texts = stored.body.data.lists.flatMap(l => l.notes.map(n => n.text));
		check(texts.includes('note from the browser'), 'the note body reached the server', texts.slice(-3));

		console.log('\n4. a remote change is pulled');
		const remote = stored.body.data;
		remote.title = 'Renamed by the other user';
		const put = await api(base, 'PUT', '/board/' + boardId, { data: remote, lastEditor: 'browser-b' }, stored.body.revision);
		check(put.status == 200, 'other user can write', put.body);

		await cdp.eval('NB.sync.poll()');
		const title = await waitFor(() => cdp.eval('$(".wrap .board .head .text").attr("_text")'), 15000, 'remote title');
		check(title == 'Renamed by the other user', 'the open board re-rendered from the server', title);

		console.log('\n5. a conflicting edit opens a dialog instead of overwriting');

		const localEdit = text => cdp.eval(`
			var $l = $('.wrap .board .list').first();
			addNote($l);
			var $n = $l.find('.note').last();
			$n.find('.edit').val(${JSON.stringify(text)});
			stopEditing($n.find('.edit'), false, false);
		`);

		const otherPush = async (title) => {
			const cur = await api(base, 'GET', '/board/' + boardId);
			cur.body.data.title = title;
			return api(base, 'PUT', '/board/' + boardId, { data: cur.body.data, lastEditor: 'browser-b' }, cur.body.revision);
		};

		const conflictUp = () => waitFor(() => cdp.eval('$(".overlay .conflict").is(":visible")'), 15000, 'conflict dialog');
		const dialogGone = () => waitFor(() => cdp.eval('! $(".overlay .conflict").is(":visible")'), 15000, 'dialog to close');

		const before = await cdp.eval('NB.storage.getBoardHistory(NB.board.id).length');

		await otherPush('Changed while you were typing');
		await localEdit('my conflicting note');
		await cdp.eval('NB.sync.push(NB.board.id)');
		await conflictUp();

		const ways = await cdp.eval('$(".overlay .conflict .pick a").map(function(){ return $(this).attr("data-what") }).get().join(",")');
		check(ways == 'theirs,mine,branch,export', 'four ways out are offered', ways);

		const who = await cdp.eval('$(".overlay .conflict .who").text()');
		check(/browser-b/.test(who), 'the dialog names who has the newer copy', who);
		check(/(just now|min ago|h ago)/.test(who), 'and how old it is', who);

		await cdp.eval('$(".overlay .conflict .pick a[data-what=theirs]").click()');
		await dialogGone();

		const after = await cdp.eval('NB.storage.getBoardHistory(NB.board.id).length');
		check(after > before, 'my version survived as a local revision (undo can reach it)', { before, after });

		const finalTitle = await waitFor(() => cdp.eval('$(".wrap .board .head .text").attr("_text")'), 15000, 'their title');
		check(finalTitle == 'Changed while you were typing', 'taking theirs applied theirs', finalTitle);

		console.log('\n6. keep mine overwrites the server copy');
		await otherPush('Theirs again');
		await localEdit('note that wins');
		await cdp.eval('NB.sync.push(NB.board.id)');
		await conflictUp();

		await cdp.eval('$(".overlay .conflict .pick a[data-what=mine]").click()');
		await dialogGone();

		const kept = await waitFor(async () => {
			const r = await api(base, 'GET', '/board/' + boardId);
			const texts = r.body.data.lists.flatMap(l => l.notes.map(n => n.text));
			return texts.includes('note that wins') ? r.body : null;
		}, 15000, 'my version to reach the server');

		check(kept.lastEditor == 'browser-a', 'the server records me as the last editor', kept.lastEditor);

		console.log('\n7. keep both branches mine into a new board');
		await otherPush('Theirs again 2');
		await localEdit('note to branch');
		await cdp.eval('NB.sync.push(NB.board.id)');
		await conflictUp();

		await cdp.eval('$(".overlay .conflict .pick a[data-what=branch]").click()');

		const branched = await waitFor(async () => {
			const r = await api(base, 'GET', '/boards');
			return r.body.length == 2 ? r.body : null;
		}, 15000, 'a second board on the server');

		const mineId = Number(branched.find(b => b.id != boardId).id);
		const mine    = branched.find(b => b.id != boardId);

		check(/\(mine\)$/.test(mine.title), 'the branch is named as mine', mine.title);

		const branchData = await api(base, 'GET', '/board/' + mineId);
		check(branchData.body.data.lists.flatMap(l => l.notes.map(n => n.text)).includes('note to branch'),
			'my notes are in the branch');

		const origTitle = await waitFor(() => cdp.eval('$(".wrap .board .head .text").attr("_text")'), 15000, 'their title');
		check(origTitle == 'Theirs again 2', 'and the original took theirs', origTitle);

		console.log('\n8. a delete that cannot reach the server does not resurrect');
		// an unreachable store, whichever transport it is
		await cdp.eval(`(async function(){
			var real = NB.sync._store;
			NB.sync._store = {
				type: 'unreachable',
				get:  async function(){ return { kind: 'error', text: 'offline' }; },
				put:  async function(){ return { kind: 'error', text: 'offline' }; },
				list: async function(){ return { kind: 'error', text: 'offline' }; },
				del:  async function(){ return { kind: 'error', text: 'offline' }; },
			};
			NB.storage.nukeBoard(${mineId});
			await NB.sync.remove(${mineId});
			NB.sync._store = real;
		})()`);

		check(await cdp.eval(`NB.sync.isDeleted(${mineId})`), 'the delete is tombstoned locally');
		check(await cdp.eval(`! NB.storage.getBoardIndex().has(${mineId})`), 'and the board is gone from the local list');

		await cdp.eval('NB.sync.poll()');

		const left = await waitFor(async () => {
			const r = await api(base, 'GET', '/boards');
			return r.body.length == 1 ? r.body : null;
		}, 15000, 'the retried delete to reach the server');

		check(left.length == 1, 'the server no longer has it', left.map(b => b.id));
		check(await cdp.eval('NB.sync.tombstones().length') == 0, 'the tombstone was cleared after the server agreed');
		check(await cdp.eval(`! NB.storage.getBoardIndex().has(${mineId})`), 'and the poll did not pull it back');

		console.log('\n9. polish');
		check(! /native code/.test(await cdp.eval('String(console.log)')), 'the console is muted by default');

		await cdp.eval('NB.debug(true)');
		check(/native code/.test(await cdp.eval('String(console.log)')), 'NB.debug(true) turns logging back on');

		await cdp.eval('NB.debug(false)');
		check(! /native code/.test(await cdp.eval('String(console.log)')), 'and NB.debug(false) mutes it again');

		await cdp.eval(`
			var m = NB.storage.getBoardIndex().get(NB.board.id);
			m.serverWho = 'bob';
			m.serverUpdated = Date.now() - 8 * 24 * 3600 * 1000;
			m.title = '<img src=x onerror=window._xss=1>';
			updateBoardIndex();
		`);

		check(await cdp.eval('$(".config .boards a.load-board .stale").length') == 1, 'a board untouched for 8 days gets a stale badge');
		check(/bob/.test(await cdp.eval('$(".config .boards a.load-board").attr("title")')), 'and the tooltip names the last editor',
			await cdp.eval('$(".config .boards a.load-board").attr("title")'));

		check(await cdp.eval('window._xss === undefined'), 'a board title cannot inject markup');
		check(await cdp.eval('$(".config .boards a.load-board img").length') == 0, 'no element was built from the title');

		await cdp.eval('NB.sync.conflicts.push({ id: 1, remote: {} }); NB.sync.updateStatus();');
		check(await cdp.eval('$(".config .sync-conf .sync-resolve").css("display")') == 'block', 'a pending conflict surfaces a Resolve link');

		await cdp.eval('NB.sync.conflicts.length = 0; NB.sync.updateStatus();');
		check(await cdp.eval('$(".config .sync-conf .sync-resolve").css("display")') == 'none', 'and hides it again once resolved');

		console.log('\n10. a second real browser on the same board');

		const { proc: p2, port: port2 } = await launchChrome(profile2);
		proc2 = p2;

		const cdpB = await connect(port2);

		await cdpB.send('Page.navigate', { url: appUrl });
		await waitFor(() => cdpB.eval('window.NB && NB.board ? NB.board.id : 0'), 20000, 'second browser to boot');

		await cdpB.eval(`
			var c = NB.storage.getConfig();
			c.sync.base = ${JSON.stringify(base)};
			c.sync.auth = ${JSON.stringify(TOKEN)};
			c.sync.who  = 'browser-b';
			NB.storage.saveConfig();
			NB.sync.start();
		`);

		check(await waitFor(() => cdpB.eval(`NB.storage.getBoardIndex().has(${boardId})`), 20000, 'B to pull the board'),
			'the second browser pulls the board from the server');

		await cdpB.eval(`openBoard(${boardId})`);
		await waitFor(() => cdpB.eval('$(".wrap .board").length > 0'), 20000, 'B to open the board');

		await cdpB.eval(`
			var $l = $('.wrap .board .list').first();
			addNote($l);
			var $n = $l.find('.note').last();
			$n.find('.edit').val('note from browser B');
			stopEditing($n.find('.edit'), false, false);
		`);

		await waitFor(async () => {
			const r = await api(base, 'GET', '/board/' + boardId);
			return r.body.data.lists.flatMap(l => l.notes.map(n => n.text)).includes('note from browser B');
		}, 20000, "B's edit to reach the server");

		check(true, "the second browser's edit reaches the server");

		await cdp.eval('NB.sync.poll()');

		const seenByA = await waitFor(() => cdp.eval(
			'$(".wrap .board .note .text").map(function(){ return $(this).attr("_text") }).get().join("|")'
		), 20000, 'A to see B');

		check(/note from browser B/.test(seenByA), 'the first browser re-renders with it', seenByA.slice(-70));

		console.log('\n11. offline edit, then reconnect');

		await cdp.send('Network.enable');
		await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

		await cdp.eval(`
			var $l = $('.wrap .board .list').first();
			addNote($l);
			var $n = $l.find('.note').last();
			$n.find('.edit').val('written while offline');
			stopEditing($n.find('.edit'), false, false);
		`);

		await sleep(1200);

		check(await cdp.eval('NB.sync.status') == 'error', 'the status reports the failed push',
			await cdp.eval('NB.sync.status + " / " + NB.sync.detail'));
		check(await cdp.eval('NB.sync.dirty.size') > 0, 'and the edit stays queued');

		const onScreen = await cdp.eval('$(".wrap .board .note .text").map(function(){ return $(this).attr("_text") }).get().join("|")');
		check(/written while offline/.test(onScreen), 'the edit is still on screen while offline');

		await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
		await cdp.eval('NB.sync.poll()');

		await waitFor(async () => {
			const r = await api(base, 'GET', '/board/' + boardId);
			return r.body.data.lists.flatMap(l => l.notes.map(n => n.text)).includes('written while offline');
		}, 20000, 'the offline edit to sync after reconnect');

		check(true, 'the offline edit reaches the server after reconnect');
		check(await cdp.eval('NB.sync.dirty.size') == 0, 'nothing is left pending');

		const stillOnScreen = await cdp.eval('$(".wrap .board .note .text").map(function(){ return $(this).attr("_text") }).get().join("|")');
		check(/written while offline/.test(stillOnScreen), 'and the board still shows it - no data loss');

		console.log('\n12. starting sync twice does not duplicate anything');

		const n1 = (await api(base, 'GET', '/boards')).body.length;

		await cdp.eval('NB.sync.start()');
		await cdp.eval('NB.sync.start()');
		await sleep(1200);

		const n2 = (await api(base, 'GET', '/boards')).body.length;

		check(n1 == n2, 'no boards were duplicated by two starts', { n1, n2 });
		check(await cdp.eval('! $(".overlay .conflict").is(":visible")'), 'and no spurious conflict dialog appeared');

		console.log('\n13. .nbx export still round-trips');

		const nbx = await cdp.eval(`
			(function(){
				var pack = exportBoard();
				return decodeURIComponent(pack.blob.split(',').slice(1).join(','));
			})()
		`);

		const parsed = JSON.parse(nbx);
		check(parsed.id == boardId, 'the export contains the open board', parsed.id);

		const copy = Object.assign({}, parsed, { id: Number(boardId) + 1, title: 'Round trip' });

		await cdp.eval(`
			window.confirm = function(){ return true };
			importBoard(${JSON.stringify(JSON.stringify(copy))});
		`);

		const imported = await waitFor(async () => {
			const r = await api(base, 'GET', '/boards');
			return r.body.find(b => b.id == String(Number(boardId) + 1)) || null;
		}, 20000, 'the imported board to reach the server');

		check(imported.title == 'Round trip', 'an imported .nbx lands as a valid board on the server', imported.title);

		const importedData = await api(base, 'GET', '/board/' + imported.id);
		check(importedData.body.data.lists.flatMap(l => l.notes.map(n => n.text)).includes('written while offline'),
			'with the same contents as the original');

		console.log('\n14. shared folder instead of a server');

		const openId = await cdp.eval('NB.board.id');

		// reset the sync bookkeeping so everything counts as "never pushed", then point sync
		// at an OPFS directory - a real FileSystemDirectoryHandle, minus the native picker
		await cdp.eval(`(async function(){
			var root = await navigator.storage.getDirectory();

			try { await root.removeEntry('share', { recursive: true }); } catch (e) { }

			var dir = await root.getDirectoryHandle('share', { create: true });

			NB.storage.getBoardIndex().forEach(function(m, id){
				m.serverRev = 0; m.serverWho = ''; m.serverUpdated = 0;
				NB.storage.setJson('board.' + id + '.meta', m);
			});

			NB.sync.stop();
			NB.sync._store = undefined;
			NB.sync.dir = dir;

			var conf = NB.storage.getConfig().sync;
			conf.folder = 'share';
			conf.base = '';
			conf.auth = '';
			NB.storage.saveConfig();
			syncConfUiLoad();

			await NB.sync.start();
			await NB.sync.flush();
		})()`);

		const inFolder = await cdp.eval(`(async function(){
			var root = await navigator.storage.getDirectory();
			var dir = await root.getDirectoryHandle('share');
			var names = [];
			for await (var e of dir.values()) names.push(e.name);
			return names.sort();
		})()`);

		check(inFolder.includes('board-' + openId + '.json'), 'boards are written to the folder', inFolder);
		check(inFolder.every(n => /^board-.*\.json$/.test(n)), 'one file per board, nothing else');

		// somebody else's board lands in the folder - this is the lead's overview
		await cdp.eval(`(async function(){
			var root = await navigator.storage.getDirectory();
			var dir  = await root.getDirectoryHandle('share');
			var fh   = await dir.getFileHandle('board-7777777.json', { create: true });
			var w    = await fh.createWritable();

			await w.write(JSON.stringify({
				id: '7777777', revision: 1, updated: Date.now(), lastEditor: 'carol',
				data: { format: NB.blobVersion, id: 7777777, revision: 1, title: "Carol's board",
				        lists: [ { title: 'Doing', notes: [ { text: 'a note from carol', raw: false, min: false } ] } ] }
			}));

			await w.close();
		})()`);

		await cdp.eval('NB.sync.poll()');

		check(await cdp.eval('NB.storage.getBoardIndex().has(7777777)'), "another user's board is picked up from the folder");
		check(await cdp.eval('$(".config .boards a.load-board[board_id=7777777]").length') == 1, 'and listed in the board menu');

		check(/carol/.test(await cdp.eval('$(".config .boards a.load-board[board_id=7777777]").attr("title")') || ''),
			'with who saved it', await cdp.eval('$(".config .boards a.load-board[board_id=7777777]").attr("title")'));

		// a neighbour rewrites our board behind our back -> the same four-way dialog
		await cdp.eval(`(async function(){
			var root = await navigator.storage.getDirectory();
			var dir  = await root.getDirectoryHandle('share');
			var name = 'board-${openId}.json';
			var doc  = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());

			doc.revision += 1;
			doc.updated = Date.now();
			doc.lastEditor = 'carol';
			doc.data.title = 'Folder conflict';

			var w = await (await dir.getFileHandle(name, { create: true })).createWritable();
			await w.write(JSON.stringify(doc));
			await w.close();
		})()`);

		await localEdit('note that collides in the folder');
		await cdp.eval('NB.sync.push(NB.board.id)');
		await conflictUp();

		check(/carol/.test(await cdp.eval('$(".overlay .conflict .who").text()')), 'a folder conflict opens the dialog too',
			await cdp.eval('$(".overlay .conflict .who").text()'));

		await cdp.eval('$(".overlay .conflict .pick a[data-what=theirs]").click()');
		await dialogGone();

		check(await cdp.eval('$(".wrap .board .head .text").attr("_text")') == 'Folder conflict',
			'and taking theirs pulls the folder version into the board');

		// deleting a board removes its file
		await cdp.eval(`(async function(){
			NB.storage.nukeBoard(7777777);
			await NB.sync.remove(7777777);
		})()`);

		check(await cdp.eval(`(async function(){
			var root = await navigator.storage.getDirectory();
			var dir  = await root.getDirectoryHandle('share');
			try { await dir.getFileHandle('board-7777777.json'); return false; } catch (e) { return true; }
		})()`), 'deleting a board removes its file from the folder');

		// the grant does not survive a page load: one click must re-arm it on the same folder
		await cdp.eval(`(async function(){
			NB.sync.stop();
			NB.sync._store = undefined;

			var root = await navigator.storage.getDirectory();
			var dir  = await root.getDirectoryHandle('share');
			var granted = false;

			dir.queryPermission   = async function(){ return granted ? 'granted' : 'prompt'; };
			dir.requestPermission = async function(){ granted = true; return 'granted'; };

			NB.sync.dir = dir;
			await NB.sync.start();
		})()`);

		check(await cdp.eval('NB.sync.status') == 'pending', 'a fresh page load asks for one click, not for the folder again',
			await cdp.eval('NB.sync.status + " / " + NB.sync.detail'));
		check(await cdp.eval('!!document.getElementById("nb-folder-bar")'), 'and puts an allow bar on the page');

		await cdp.eval('NB.sync.allowFolder()');
		await sleep(1500);

		const allowState = await cdp.eval(
			'NB.sync.status + " / " + NB.sync.detail + " / pending=" + !!NB.sync.pending'
			+ ' + " / conflicts=" + NB.sync.conflicts.length + " / dirty=" + NB.sync.dirty.size');

		check(/^ok /.test(allowState), 'one click turns sync back on', allowState);
		check(await cdp.eval('!document.getElementById("nb-folder-bar")'), 'and drops the bar');
		check(await cdp.eval('NB.sync._store && NB.sync._store.type') == 'folder',
			'against the same folder, without picking it again');

		// configured folder, but this browser has no handle for it (fresh profile, or a
		// browser that refuses to keep the permission)
		await cdp.eval(`(async function(){
			NB.sync.stop();
			NB.sync._store = undefined;
			NB.sync.dir = null;
			await idbDel('folder');
			await NB.sync.start();
		})()`);

		check(/not available here/.test(await cdp.eval('NB.sync.detail')),
			'a folder this browser has no handle for says so',
			await cdp.eval('NB.sync.status + " / " + NB.sync.detail'));
	}
	finally
	{
		proc.kill('SIGKILL');
		if (proc2) proc2.kill('SIGKILL');
		await new Promise(r => { proc.once('exit', r); setTimeout(r, 3000); });
		await new Promise(r => syncServer.close(r));
		await new Promise(r => appServer.close(r));
		await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		await fsp.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		await fsp.rm(profile2, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}

	console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\n${checks} checks passed`);
	process.exit(failures ? 1 : 0);
}

main().catch(x => { console.error('\n' + (x.stack || x.message)); process.exit(1); });
