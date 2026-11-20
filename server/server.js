#!/usr/bin/env node
/*
 *	Nullboard sync server - Phase 1 of Backlog.md
 *
 *	One JSON file per board on disk. The server owns `revision`; clients send
 *	`If-Match` and get a 409 when they are stale. Deleted boards leave a tombstone
 *	so a stale client cannot resurrect them.
 *
 *	Env: NB_TOKEN (required), NB_PORT (default 10001 = nullboard's default agent port),
 *	     NB_DATA (default ./data)
 *
 *	Zero dependencies.
 */

'use strict';

const http = require('node:http');
const fs   = require('node:fs/promises');
const path = require('node:path');

const ID_RE      = /^[A-Za-z0-9_-]{1,64}$/;   // also guards path traversal
const MAX_BODY   = 5 * 1024 * 1024;
const MAX_EDITOR = 64;

/*
 *	storage
 */

const boardFile   = (dir, id) => path.join(dir, id + '.json');
const tombstoneFile = (dir, id) => path.join(dir, id + '.deleted.json');

async function readJson(file)
{
	try   { return JSON.parse(await fs.readFile(file, 'utf8')); }
	catch (x) { return null; }   // ENOENT or corrupt - treated as "no board"
}

async function writeJsonAtomic(file, obj)
{
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

	await fs.writeFile(tmp, JSON.stringify(obj));
	await fs.rename(tmp, file);   // atomic on the same filesystem
}

/*
 *	per-board serialization - the read/check/write in a PUT spans an await, so two
 *	concurrent PUTs carrying the same If-Match would both otherwise win.
 */

const locks = new Map();

function withLock(key, fn)
{
	const prev = locks.get(key) || Promise.resolve();
	const next = prev.then(fn, fn);
	locks.set(key, next.then(() => {}, () => {}));
	return next;
}

/*
 *	http
 */

function send(res, code, body)
{
	const headers = { 'Access-Control-Allow-Origin': '*' };

	if (body !== undefined)
	{
		headers['Content-Type'] = 'application/json';
		res.writeHead(code, headers);
		res.end(JSON.stringify(body));
	}
	else
	{
		res.writeHead(code, headers);
		res.end();
	}
}

function readBody(req)
{
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];

		req.on('data', c => {
			size += c.length;
			if (size > MAX_BODY)
			{
				req.destroy();
				return reject(new Error('body too large'));
			}
			chunks.push(c);
		});
		req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function boardProblem(data, id)
{
	if (! data || typeof data !== 'object' || Array.isArray(data))
		return 'data must be an object';

	for (const p of [ 'format', 'id', 'revision', 'title', 'lists' ])
		if (! (p in data))
			return `data.${p} is missing`;

	if (! Array.isArray(data.lists))
		return 'data.lists must be an array';

	if (String(data.id) !== id)
		return `data.id (${data.id}) does not match the board id (${id})`;

	return null;
}

/*
 *	app
 */

function createHandler(dir, token)
{
	return async function handler(req, res)
	{
		if (req.method === 'OPTIONS')
		{
			res.writeHead(204, {
				'Access-Control-Allow-Origin'  : '*',
				'Access-Control-Allow-Methods' : 'GET, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers' : 'Content-Type, X-Access-Token, If-Match',
				'Access-Control-Max-Age'       : '600',
			});
			return res.end();
		}

		if (req.headers['x-access-token'] !== token)
			return send(res, 401, { error: 'bad token' });

		const url = new URL(req.url, 'http://x');
		const seg = url.pathname.split('/').filter(s => s.length);

		try
		{
			if (seg.length === 1 && seg[0] === 'boards' && req.method === 'GET')
				return send(res, 200, await listBoards(dir));

			if (seg.length !== 2 || seg[0] !== 'board')
				return send(res, 404, { error: 'not found' });

			const id = seg[1];

			if (! ID_RE.test(id))
				return send(res, 400, { error: 'bad board id' });

			if (req.method === 'GET')    return await getBoard(dir, id, url, res);
			if (req.method === 'PUT')    return await putBoard(dir, id, req, res);
			if (req.method === 'DELETE') return await deleteBoard(dir, id, res);

			return send(res, 405, { error: 'method not allowed' });
		}
		catch (x)
		{
			console.error(x);
			return send(res, 500, { error: 'internal error' });
		}
	};
}

async function listBoards(dir)
{
	let names;

	try   { names = await fs.readdir(dir); }
	catch (x) { return []; }

	const out = [];

	for (const name of names)
	{
		if (! name.endsWith('.json') || name.endsWith('.deleted.json') || name.includes('.tmp'))
			continue;

		const b = await readJson(path.join(dir, name));
		if (! b || b.deleted) continue;

		out.push({
			id         : b.id,
			title      : (b.data && b.data.title) || '',
			revision   : b.revision,
			updated    : b.updated,
			lastEditor : b.lastEditor,
		});
	}

	return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

async function getBoard(dir, id, url, res)
{
	const b = await readJson(boardFile(dir, id));

	if (! b) return send(res, 404, { error: 'no such board' });
	if (b.deleted) return send(res, 410, { error: 'board deleted', revision: b.revision });

	const want = url.searchParams.get('rev');

	if (want !== null && Number(want) === b.revision)
		return send(res, 304);

	return send(res, 200, { revision: b.revision, updated: b.updated, lastEditor: b.lastEditor, data: b.data });
}

async function putBoard(dir, id, req, res)
{
	let body;

	try   { body = JSON.parse(await readBody(req) || 'null'); }
	catch (x) { return send(res, 400, { error: 'body is not valid JSON' }); }

	if (! body || typeof body !== 'object')
		return send(res, 400, { error: 'body must be an object' });

	const whoops = boardProblem(body.data, id);
	if (whoops) return send(res, 400, { error: whoops });

	const editor = String(body.lastEditor || '').slice(0, MAX_EDITOR);
	const ifMatch = req.headers['if-match'];

	await withLock(id, async () => {

		const tomb = await readJson(tombstoneFile(dir, id));

		if (tomb && tomb.deleted)
			return send(res, 410, { error: 'board deleted', revision: tomb.revision, updated: tomb.updated });

		const have = await readJson(boardFile(dir, id));

		// absent or empty If-Match = create-if-absent, which makes client migration idempotent
		if (ifMatch === undefined || ifMatch === '' || ifMatch === '0')
		{
			if (have && ! have.deleted)
				return send(res, 409, { error: 'board already exists', revision: have.revision, updated: have.updated, lastEditor: have.lastEditor });
		}
		else
		if (! have || Number(ifMatch) !== have.revision)
		{
			return send(res, 409, {
				error      : 'stale revision',
				revision   : have ? have.revision : 0,
				updated    : have ? have.updated  : 0,
				lastEditor : have ? have.lastEditor : '',
			});
		}

		const revision = (have ? have.revision : 0) + 1;
		const now = Date.now();

		await writeJsonAtomic(boardFile(dir, id), {
			id, revision, updated: now, lastEditor: editor, data: body.data,
		});

		return send(res, 200, { revision, updated: now });
	});
}

async function deleteBoard(dir, id, res)
{
	await withLock(id, async () => {

		const have = await readJson(boardFile(dir, id));

		if (! have || have.deleted)
			return send(res, 404, { error: 'no such board' });

		const revision = have.revision + 1;
		const now = Date.now();

		await writeJsonAtomic(boardFile(dir, id), { id, deleted: true, revision, updated: now, lastEditor: have.lastEditor });
		await writeJsonAtomic(tombstoneFile(dir, id), { id, deleted: true, revision, updated: now });

		return send(res, 200, { revision, deleted: true });
	});
}

/*
 *	start
 */

async function start({ port = 10001, dir, token, host = '127.0.0.1' } = {})
{
	if (! dir)   throw new Error('data dir is required');
	if (! token) throw new Error('NB_TOKEN (access token) is required');

	await fs.mkdir(dir, { recursive: true });

	const server = http.createServer(createHandler(dir, token));

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});

	return server;
}

if (require.main === module)
{
	const token = process.env.NB_TOKEN;

	if (! token)
	{
		console.error('NB_TOKEN is not set - refusing to start without an access token.');
		process.exit(1);
	}

	start({
		port : Number(process.env.NB_PORT || 10001),
		dir  : process.env.NB_DATA || path.join(__dirname, 'data'),
		token,
	}).then(server => {
		const a = server.address();
		console.log(`nullboard-sync listening on http://${a.address}:${a.port}`);
	}).catch(x => {
		console.error(x.message);
		process.exit(1);
	});
}

module.exports = { start, createHandler };
