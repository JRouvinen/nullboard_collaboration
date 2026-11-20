'use strict';

/*
 *	Phase 1 self-check: node --test server/
 *	Owns the safety property that matters - a stale client can never overwrite,
 *	and a deleted board cannot be resurrected.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');

const { start } = require('./server');

const TOKEN = 'test-token';

let server, base, dir;

const board = (id, title = 'Board') => ({ format: 20190412, id, revision: 1, title, lists: [] });

async function call(p, { method = 'GET', body, headers = {} } = {})
{
	const res = await fetch(base + p, {
		method,
		headers: { 'X-Access-Token': TOKEN, 'Content-Type': 'application/json', ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await res.text();

	return { status: res.status, body: text ? JSON.parse(text) : null };
}

const put = (id, data, rev, extra = {}) =>
	call(`/board/${id}`, { method: 'PUT', body: { data, lastEditor: 'tester', ...extra }, headers: rev === undefined ? {} : { 'If-Match': String(rev) } });

test.before(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-sync-'));
	server = await start({ port: 0, dir, token: TOKEN });
	base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
	await new Promise(r => server.close(r));
	await fs.rm(dir, { recursive: true, force: true });
});

test('rejects a missing token', async () => {
	const res = await fetch(base + '/boards');
	assert.strictEqual(res.status, 401);
});

test('creates, reads, and reports its revision', async () => {
	const created = await put('b1', board('b1'), '0');
	assert.strictEqual(created.status, 200);
	assert.strictEqual(created.body.revision, 1);

	const got = await call('/board/b1');
	assert.strictEqual(got.status, 200);
	assert.strictEqual(got.body.revision, 1);
	assert.strictEqual(got.body.lastEditor, 'tester');
	assert.deepStrictEqual(got.body.data.lists, []);

	const index = await call('/boards');
	assert.strictEqual(index.status, 200);
	assert.deepStrictEqual(index.body.map(b => b.id), ['b1']);
	assert.strictEqual(index.body[0].title, 'Board', 'the index must project the board title, not the file wrapper');
});

test('304 when the revision is unchanged', async () => {
	assert.strictEqual((await call('/board/b1?rev=1')).status, 304);
	assert.strictEqual((await call('/board/b1?rev=0')).status, 200);
});

test('a stale If-Match is rejected and reports who holds the truth', async () => {
	const ok = await put('b1', board('b1', 'v2'), 1);
	assert.strictEqual(ok.status, 200);
	assert.strictEqual(ok.body.revision, 2);

	const stale = await put('b1', board('b1', 'lost'), 1);
	assert.strictEqual(stale.status, 409);
	assert.strictEqual(stale.body.revision, 2);
	assert.strictEqual(stale.body.lastEditor, 'tester');

	const got = await call('/board/b1');
	assert.strictEqual(got.body.data.title, 'v2', 'stale write must not land');
});

test('create-if-absent does not clobber an existing board', async () => {
	const dupe = await put('b1', board('b1', 'dupe'), '0');
	assert.strictEqual(dupe.status, 409);

	const absent = await put('b1', board('b1', 'dupe'));
	assert.strictEqual(absent.status, 409, 'a missing If-Match on an existing board is a conflict');
});

test('concurrent writes carrying the same If-Match: exactly one wins', async () => {
	const results = await Promise.all([
		put('race', board('race', 'A'), '0'),
		put('race', board('race', 'B'), '0'),
	]);

	const codes = results.map(r => r.status).sort();
	assert.deepStrictEqual(codes, [200, 409]);

	const got = await call('/board/race');
	assert.strictEqual(got.body.revision, 1);
});

test('delete leaves a tombstone that cannot be resurrected', async () => {
	const del = await call('/board/race', { method: 'DELETE' });
	assert.strictEqual(del.status, 200);

	const gone = await call('/board/race');
	assert.strictEqual(gone.status, 410);

	const revive = await put('race', board('race', 'zombie'), '0');
	assert.strictEqual(revive.status, 410, 'a stale client must not resurrect a deleted board');

	const index = await call('/boards');
	assert.ok(! index.body.some(b => b.id === 'race'));
});

test('rejects bad ids and mismatched payloads', async () => {
	assert.strictEqual((await call('/board/..%2Fescape')).status, 400);
	assert.strictEqual((await call('/board/' + 'x'.repeat(80))).status, 400);
	assert.strictEqual((await put('b1', board('other'), 2)).status, 400, 'data.id must match the path');
	assert.strictEqual((await put('b1', { format: 1, id: 'b1', revision: 1, title: 't' }, 2)).status, 400, 'lists is required');
	assert.strictEqual((await call('/board/b1', { method: 'PUT', body: { data: null } })).status, 400);
	assert.strictEqual((await call('/nope')).status, 404);
});

test('survives a restart - data is on disk', async () => {
	await new Promise(r => server.close(r));

	server = await start({ port: 0, dir, token: TOKEN });
	base = `http://127.0.0.1:${server.address().port}`;

	const got = await call('/board/b1');
	assert.strictEqual(got.status, 200);
	assert.strictEqual(got.body.revision, 2);
});
