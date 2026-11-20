# Backlog — Nullboard as a multi-user board

Goal: users keep their own boards, boards live on a shared server, clients reconcile
every 60 s, the app stays fully usable offline. **No real-time collaboration, no CRDT.**

Baseline: `nullboard.html`, 5,185 lines, `codeVersion 20231105`, `blobVersion 20190412`.
Model: `Board{format,id,revision,title,lists:[{title,notes:[{text,raw,min}]}]}`.

**Verdict: this is an additive change, not a restructure.** The existing `Storage` class is
the seam. Add `Storage_Remote` beside `Storage_Local`, add a poll loop, add conflict
detection. ~5-6 dev-days. The earlier real-time plan (Yjs, keyed rendering, entity ids,
presence) is dead — see *Dropped* below so nobody re-adds it.

---

## Use cases

| # | Case |
|---|---|
| UC1 | Each user owns their board(s) and authors them. |
| UC2 | At any moment a given board has one active editor (policy, not guarantee). |
| UC3 | Clients pull remote changes every 60 s. |
| UC4 | Changes are also pushed on save, so the loss window is ~0 rather than 60 s. |
| UC5 | The app keeps working offline and reconciles on reconnect. |
| UC6 | Two people on one board must never silently lose work — one gets a conflict dialog. |
| UC7 | **No server process.** The app lives on a shared network drive, each user opens it from there, and the folder itself is the shared copy. The lead and the team can see everyone's boards. |

---

## Decisions taken

Revise only with a reason; each unblocks a lot of code.

1. **Boards are shared documents, one editor at a time** (reading (b)). If boards turn out
   to be strictly private, delete Phase 3 entirely and the job gets trivial.
2. **Conflict handling is optimistic, with no server-side locks.** Client sends
   `If-Match: <base revision>`; server answers `409` on mismatch; UI offers
   *take theirs* / *keep mine* / *export mine (.nbx)*. Zero server state, ~0 lines of
   locking. Upgrade to a 2-minute soft lease only if `409` dialogs actually annoy people.
3. **Local-first stays.** localStorage keeps writing immediately as today and remains the
   offline cache. The 60 s loop only reconciles. Nothing about the edit path changes.
4. **Poll-only pull, push on save.** 60 s interval for *pulling*; an immediate `PUT` on
   save. Same code, turns the worst-case loss from 60 s into ~0.
5. **Mobile out of scope.** README already says desktop-only and `Drag2` (~2665) is
   mouse-event based.
6. **One shared server token for the team**, not per-board tokens (see Phase 1). Six
   trusted people, one deployment; revisit only if boards need different audiences.
7. **Folder mode is the primary transport (Phase 6); the HTTP server stays.** Folder mode
   needs the File System Access API (Edge/Chrome yes, Firefox no); the team is on Edge +
   Chrome, so it is available to everyone. The server path stays in the code, unchanged and
   tested, as the fallback and for any Firefox user.
8. **Per-board files, not per-user files**, on the share: `board-<id>.json`, one writer
   each. It maps 1:1 onto the existing `push(id)` / `pullBoard(id)` / `remove(id)` engine and
   keeps conflict granularity at the board. Cost: filenames are opaque ids; the board list
   shows titles, so nobody has to read the folder by hand.

---

## Status

| Phase | State |
|---|---|
| 0 — Licence gate | ✅ decision (a), internal tool |
| 1 — Server | ✅ done, 9/9 unit tests |
| 2 — Sync layer + poll loop | ✅ done |
| 3 — Conflict UX | ✅ done |
| 4 — Polish | ✅ done |
| 5 — Tests | ✅ done, 57/57 e2e checks |
| 6 — Shared-folder sync, no server | ✅ done |

---

## Phase 0 — Licence gate — ✅ DONE 2026-11-20

**Decision (a): internal tool for the 6-person team, stays on this fork.**
BSD-2-Clause + Commons Clause permits use, modification and internal distribution; we do
not sell it. Nothing is published as a product.

- [x] Licence question resolved — no clean-room rewrite, no upstream commercial licence.
- [x] Implication accepted: the fork stays private, and "sell this" is off the table
      unless the licence is revisited first.

---

## Phase 1 — Server — ✅ DONE (`server/server.js`, `server/test.js`)

One Node service, zero dependencies, JSON file per board on disk.

- [x] `GET  /boards` → board index (`{id, title, revision, updated, lastEditor}`).
- [x] `GET  /board/:id?rev=N` → `304` if unchanged, else `{revision, updated, lastEditor, data}`.
- [x] `PUT  /board/:id` with `If-Match: <rev>` → `200 {rev}` or `409 {revision, updated, lastEditor}`.
      **The server owns the revision.** The client must stop computing it
      (`rev_new = meta.history[0] + 1`, line 1907) and treat the server value as truth.
      Empty/absent/`0` If-Match = create-if-absent (409 if the board already exists), so
      client migration is idempotent.
- [x] `DELETE /board/:id` → tombstone (`<id>.deleted.json`); `GET` returns `410`, and a
      `PUT` on a tombstoned board returns `410` too, so a stale client cannot resurrect it.
- [x] Auth: `X-Access-Token`, reusing the header `SimpleBackup` already sends
      (`checkStatus` ~2477). **Deviation: one shared server token (`NB_TOKEN`), not
      per-board tokens** — enough for a trusted 6-person team. Deferred, not dropped.
- [x] Atomic writes (temp file + rename), per-board write lock so two concurrent PUTs
      carrying the same `If-Match` cannot both win, 5 MB body cap, id regex guarding path
      traversal, payload validation mirroring `checkImport` (3496).
- [x] CORS preflight handled — browsers on another origin can talk to it.

### Definition of done — met
`node --test server/test.js` → 9/9: create, 304, stale-409, create-if-absent, concurrent
race (exactly one 200), delete/tombstone/no-resurrection, bad payloads, restart-from-disk.

### How to run
```sh
NB_TOKEN=<secret> node server/server.js      # port 10001 by default
node --test server/test.js                   # server contract, 9 checks
node server/e2e.js                           # real browser end-to-end, 57 checks
```
`server/e2e.js` needs a Chrome/Chromium binary; it looks for the Playwright cache under
`~/.cache/ms-playwright/` and honours `CHROME=/path/to/chrome`.

Port 10001 is deliberate: it is the base URL `default_backup_agents` already points at
(`http://127.0.0.1:10001`, ~1749), so the client needs no new config to find it.

---

## Phase 2 — sync layer + poll loop — ✅ DONE

**Deviation from the plan: no `Storage_Remote` subclass.** Implementing `getItem`/`setItem`
against HTTP would have thrown away the offline behaviour we wanted to keep (decision 3).
Instead: a `Sync` object sits *beside* `Storage_Local`, which stays the write-through cache.
Smaller, and it keeps the whole edit path untouched.

- [x] `Sync` class (`class Sync`, in the model script block next to `Board`): `push`,
      `poll`, `pullBoard`, `remove`, `flush`, `touch`, status reporting.
- [x] `Storage_Local` untouched except `BoardMeta.serverRev`, which is sync bookkeeping
      only. Local revisions still drive undo and are still computed as before
      (`rev_new = meta.history[0] + 1`) — the server revision never mixes with them.
- [x] Push on save: the UI `saveBoard()` calls `NB.sync.touch(id)`; a 400 ms debounce
      coalesces a burst, and every poll starts with `flush()` so a failed push retries
      within 60 s. Local write stays immediate, so editing never waits on the network.
- [x] Poll: `setInterval(poll, 60s)` → `GET /boards`, cheap; a board is fetched only when
      its `revision` moved, and a `304` costs nothing. New boards on the server are pulled
      into the local index (a teammate's board shows up in your list — this is the
      "sync between boards" reading of UC1; revisit if boards should stay private).
- [x] Applying a remote board stores it as a **fresh local revision**, so undo can step
      back over it — no remote change is ever unrecoverable.
- [x] Re-render only when the board is open *and* nothing is being edited or dragged
      (`isBusyEditing()`: `.editing` or `body.dragging`). Otherwise the local copy updates
      silently in storage.
- [x] Never overwrite silently: `409` opens a dialog naming who changed it and when, with
      *keep mine (overwrite)* / *take theirs (mine stays in undo history)*. The
      *export mine* branch is Phase 3.
- [x] 401 → "bad token", 410 → "deleted on the server" (no resurrection), offline →
      status shows `offline` and the next tick retries. Editing is never blocked.
- [x] `Board.id`: **deviation** — monotonic `nextBoardId()` instead of "append a random
      suffix". `Storage_Local.openInner` scans `^nullboard\.board\.(\d+)\.meta$`, so ids
      must stay numeric. This fixes same-ms collisions *within* one browser; a cross-user
      same-ms collision now surfaces as a loud `409` on create instead of silent
      overwrite. Documented residual risk, accepted.
- [x] Sync settings UI in the config menu (Server / Token / Name / Sync now / Status).
      Enabling sync pushes every board that has never been pushed, so pre-sync boards and
      fresh installs need no separate migration step.

### Bug found by the e2e (fixed)
`data.revision` on the wire is the *sender's* local counter. `Storage.saveBoard` reads
`rev_old < rev < rev_new` as "revisions skipped by undo — delete them", so applying a
remote board whose revision was lower than ours **deleted our local revisions**, losing
the conflicting edit from undo history. `pullBoard` now sets `board.revision = meta.current`
before storing. Comment in the code, because it is not obvious.

### Self-check — `node server/e2e.js`
16/16, real Chromium over CDP, real server, real `nullboard.html` served over HTTP
(so localStorage and the CORS preflight are exercised for real): version renders · sync
off until configured · first push is rev 1 with the editor name · local edit bumps the
server rev and the note body arrives · remote change re-renders the open board · conflicting
edit shows the dialog instead of overwriting · my version stays reachable in undo history ·
the other user's version survives.

Not covered yet: two browsers side by side (the "other user" is simulated over HTTP),
and offline → reconnect (the client half of UC5).

---

## Phase 3 — Conflict UX — ✅ DONE

- [x] `confirm()` replaced by a modal (`.overlay .conflict`, reusing the `.backup-conf`
      chrome so it cost almost no CSS). Four branches:
      **Take theirs** (reload, mine stays in undo history) · **Keep mine** (re-PUT on top of
      their revision) · **Keep both** (mint a new board from my copy, then take theirs —
      nothing is lost either way) · **Export mine first** (downloads a `.nbx`, dialog stays
      open so you can still choose).
- [x] Conflicts queue: one dialog at a time, later conflicts wait their turn. A board
      waiting for a decision is in `Sync.conflicted` and is never pushed or pulled until
      resolved, so no dialog spam and no silent overwrite.
- [x] Dismissing the dialog (×, backdrop, Escape) is not a decision: the board stays
      conflicted and the dialog comes back on the next poll, with `!` in the sync menu.
- [x] `lastEditor` + `updated` stored in `BoardMeta` (`serverWho`, `serverUpdated`), set on
      push and on pull, refreshed for every board from `GET /boards` even when the board is
      not pulled. **Deviation:** shown as a hover tooltip on the board-list entry
      (`"bob, synced 5 min ago"`) rather than a visible badge — the house style hides
      almost everything until hovered. A visible stale badge is Phase 4 if it is wanted.
- [x] Tombstones: `conf.deleted` records a board id **before** the `DELETE` is attempted,
      so a delete that cannot reach the server still stops the next poll from pulling the
      board back. The entry is dropped once the server agrees (`200/404/410`); the next poll
      retries any that failed.

### Bug found by the e2e (fixed, server-side)
`GET /boards` projected `b.title`, but the stored document keeps the board under `b.data` —
the index returned no title at all for every board. Now projects `b.data.title`, with a unit
test so it cannot come back.

### Self-check — `node server/e2e.js`, 57 checks
steps 1-4 as before, plus: the conflict opens a dialog with four ways out · names who has the
newer copy and how old it is · *take theirs* keeps my version reachable by undo · *keep mine*
lands on the server with me as last editor · *keep both* produces a second board named
`... (mine)` containing my notes while the original takes theirs · an offline delete is
tombstoned, retried on the next poll, cleared when the server agrees, and never resurrected.

---

## Phase 4 — Polish — ✅ DONE

- [x] Board list: a **stale** badge for boards untouched for > 7 days, and the
      `bob, synced 5 min ago` tooltip.
- [x] **XSS fixed while in there:** the board list rendered `entry.meta.title` with
      `.html()`. That was already unsafe with local titles; with sync the title arrives from
      another person over the network. Now `.text()` into a `<span>`, asserted by a test that
      pushes `<img onerror=...>` through a board title.
- [x] Console spam: `console.log` is muted unless `conf.debug` is set; `NB.debug(true)` in
      the devtools console turns it back on and persists. Done as one override rather than
      41 call-site edits.
- [x] `setInterval(adjustListScroller, 100)` removed. It now runs from `adjustLayout()`
      (resize, font/list-width prefs, board open - it already ran there) and from
      `saveBoard()` (add/remove/move list changes the scroll width).
- [x] **Resolve conflict...** in the sync menu reopens a dismissed conflict instead of
      waiting for the next poll.
- [x] `README.md` has a **Sync (this fork)** section: how to run the server, what the three
      settings mean, what the four conflict choices do, and how to recover a board that was
      overwritten (local undo, else the last `.nbx`). That last part is the documented
      recovery path the server cannot provide - it keeps one copy per board, not history.

### Verification
`node server/e2e.js` → 57 checks. New in this phase: console muted by default / `NB.debug`
toggles it / stale badge appears after 8 days / tooltip names the last editor / a board
title cannot inject markup / a pending conflict surfaces and hides its Resolve link. Also
visually checked in a real browser.

---

## Phase 5 — Tests — ✅ DONE

`server/e2e.js` now launches **two real Chromium instances** (two profiles, two CDP
sessions) and can take one of them genuinely **offline** via
`Network.emulateNetworkConditions`.

- [x] Two real browsers on one board: B pulls A's board from the server, B's edit reaches the
      server, A's poll re-renders it. _(step 10.)_
- [x] Offline edit → reconnect: push fails, status says `error`, the edit stays queued and on
      screen, then lands on the server on the next poll, board unchanged. _(step 11.)_
- [x] `NB.sync.start()` twice: no duplicated boards, no spurious conflict dialog. _(step 12.)_
- [x] `.nbx` round-trip: export the open board, re-import it under a new id, it lands on the
      server with the same contents. _(step 13 - guards the "export mine" recovery path.)_
- [x] `If-Match` accept/reject, `304`, all four conflict branches, offline delete. _(steps 1-8.)_

### Bug found by these tests (fixed)
`importBoard()` called `NB.storage.saveBoard()`, which never notifies sync — so a board
imported while sync was on sat local-only until somebody happened to edit it. Exactly the
wrong behaviour for the "export mine / import it later" recovery path the conflict dialog
advertises. Now `importBoard` calls `NB.sync.touch()` after saving. This is why the `.nbx`
test had to exist rather than be assumed.

### Still untested
- Two clients *simultaneously* mid-edit on one board (the conflict path is tested, but
  serially). At a 60 s cadence with a 4-way dialog this is accepted, per decision 2.
- A server restart mid-poll (the server-side restart case is covered in `server/test.js`).
- Touch/mobile input, out of scope by decision 5.

---

## Phase 6 — Shared-folder sync, no server — ✅ DONE

Goal: the app sits on the shared drive, everyone opens `Z:\...\nullboard.html`, and the
folder *is* the shared copy. No process on anybody's machine. The lead opens the app and
sees every board in the team with "last saved by X, 5 min ago".

### What makes this possible (measured, not assumed)
Opened as `file://`, Chromium reports `isSecureContext: true` and permits
`showDirectoryPicker({mode:'readwrite'})` from a user gesture. `fetch`/XHR to a `file://`
path are blocked, so the page cannot read the share by itself - the folder handle it was
*granted* is the only way in. Edge and Chrome both have it; **Firefox has no File System
Access API at all** and gets the server mode or manual `.nbx` instead.

### 6.1 Split the transport out of `Sync` — done
`Sync` currently reaches the network only through `this.api()`. Replace it with a store
interface - `get(id)`, `put(id, doc)`, `list()`, `del(id)` - returning one normalized result
shape (`ok | unchanged | conflict | gone | missing | error` + `revision/updated/lastEditor/data`)
instead of raw HTTP statuses. Two implementations: `StoreHttp` (today's `api()`, unchanged
behaviour) and `StoreFolder`. `push`/`poll`/`pullBoard`/`remove`/dirty/tombstones/conflicts
are not otherwise touched - that is the whole point of the split.

### 6.2 `StoreFolder` — done
- `showDirectoryPicker({ mode: 'readwrite' })` from the **Choose sync folder...** button;
  the `FileSystemDirectoryHandle` is stored in **IndexedDB** (handles are structured-cloneable,
  the config JSON is not).
- `queryPermission({mode:'readwrite'})` on load: `granted` → sync silently, `prompt` → status
  `folder permission needed` plus one click to restore, `denied` → off.
- Document on disk: `{ id, revision, updated, lastEditor, data }` - exactly what the server
  stores, so both transports share one shape.
- Read: `for await (entry of dir.values())`, `getFile().text()`. Write: `createWritable()`
  then `close()` (Chromium swaps a temp file on close, which is what makes this safe on SMB).
  Delete: `removeEntry()`.
- Not found / not permitted must map onto `missing` / `error`, not throw.

### 6.3 UI — done
- Sync section: **Choose sync folder...**, the chosen folder name, and the permission state.
  Folder mode is used when a folder is set, server mode when Server+Token are set.
- Hide the button and say so when `!window.showDirectoryPicker` (Firefox/Safari).
- Everything else already works: board list with `last saved by` + stale badges is exactly the
  lead's overview, and the four-way conflict dialog still applies if someone edits a board
  that is not theirs.

### 6.4 Verification — done
- **e2e without a picker:** `navigator.storage.getDirectory()` (OPFS) returns a real
  `FileSystemDirectoryHandle`, so `StoreFolder` can be pointed at it and exercised for real -
  `createWritable`, `getFile`, `removeEntry`, enumeration - with no native dialog. Cover:
  push writes a file · a file appearing in the folder is pulled in (this *is* the lead's
  overview) · a newer file revision triggers the conflict dialog · delete removes the file ·
  permission denied surfaces as `error` and retries.
- **Manual, once per team:** on a Windows box, pick the share, restart the browser, confirm
  whether the permission survives. This is the single unknown and it decides whether users
  click once a day or once ever.

### What actually happened

- `Store` / `StoreHttp` / `StoreFolder` now sit under `Sync`, which speaks only the
  normalized result shape. **The HTTP path was not rewritten, it was moved** - all of steps
  1-13 (the old suite) still pass against it, unchanged, which is the check that the split
  did not quietly change behaviour.
- Folder documents are `{ id, revision, updated, lastEditor, data }` - the same shape the
  server stores.
- A corrupt/unreadable file is never overwritten: `put` reports `error` and leaves it alone,
  so a torn SMB read cannot destroy a neighbour's board.
- `chooseFolder` stores the `FileSystemDirectoryHandle` in IndexedDB; `openFolder` asks
  `queryPermission` and, when it is not `granted`, puts an actionable sentence in the status
  line instead of failing.
- Devtools-only escape hatch: `NB.sync.chooseFolder()`, `NB.sync.forgetFolder()`,
  `NB.sync.dir = <handle>`.

### Verification

`node server/e2e.js` → 57 checks. Step 14 drives the folder transport against a **real**
`FileSystemDirectoryHandle` (`navigator.storage.getDirectory()`, i.e. OPFS) so
`createWritable`, `getFile`, `removeEntry` and `values()` are exercised for real, no native
dialog needed: boards are written as files · a `board-7777777.json` dropped in by "carol"
appears in the board menu with her name · a newer file revision opens the same four-way
dialog and *take theirs* pulls it in · deleting a board removes its file · a folder needing
permission says so · a folder this browser has no handle for says so.

Measured on a `file://` page (the real deployment), separately:

| Probe | Result |
|---|---|
| app boots, `localStorage` | works |
| **`indexedDB`** (for the folder handle) | **works** - so the handle can survive a reload |
| `navigator.storage.getDirectory()` (OPFS) | **blocked** by Chrome on `file://` |
| `showDirectoryPicker` from a gesture | permitted (no SecurityError) |
| `fetch`/XHR to `file://` | blocked |

OPFS being blocked is why the folder transport cannot be exercised headlessly *from a
`file://` page*. It does not block the picked-folder path, which is a different API and was
shown to be permitted - but it does mean **the last mile stays manual**: on one Windows
machine, pick the real share, restart the browser, and see whether the permission survives.
If it does not, it is one click per session and the status line already asks for it.

### Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Folder permission does not survive a browser restart on `file://` | medium | the handle itself does persist (IndexedDB works on `file://`); if the *permission* does not, it is one click per session and the status line asks for it |
| SMB `createWritable` close is not atomic | high | one writer per file, so a torn read is only ever us reading *someone else's* file - and an unreadable file is reported as `error` and never overwritten |
| Somebody edits a board that is not theirs | medium | revision check + existing conflict dialog, unchanged |
| Firefox | low | server mode or manual `.nbx`; stated in the README |
| Two users with the same board id (both created boards in the same millisecond) | low | ids are already monotonic per browser; a clash shows up as a conflict, not a silent overwrite |

### Not in this phase
- An aggregate read-only "Overview" screen (all boards' columns at once). Worth considering
  *after* this ships, since it is literally the lead's goal - but board list + click may
  already be enough, and it is a new screen, not a transport change.
- Locking. With one owner per board there is nothing to lock.

---

## Dropped — do not re-add

Costed in the previous plan, worthless at this cadence:

| Item | Why not |
|---|---|
| Yjs / Automerge / WebSocket rooms (5-7 d) | 60 s polling needs no CRDT. |
| Presence, carets, remote cursors (2-3 d) | Nothing live to show. |
| Keyed rendering, kill `$wrap.html('')` (2-3 d) | Re-render on remote change is fine; UC2 means the user isn't mid-keystroke on someone else's board. |
| Stable ids on lists/notes (1-2 d) | Ids buy addressability for diffs/merges. Whole-board PUT + `409` needs none. |
| In-memory model authoritative (2 d) | `saveBoard()` scraping the DOM only hurts under uninvited concurrent updates. |
| Per-client undo (2-3 d) | The existing 50-revision local snapshot history (1732) *is* the undo stack, and is correct again under UC2. |
| Mobile / `Drag2` pointer events | Out of scope by decision 5. |

---

## Non-goals

- No real-time sync, no collaborative text editing, no locking service.
- No accounts/passwords/OAuth — a per-board token and a display name.
- No framework migration, no build step, no bundler.
- No plugin system, custom fields, templates, automation, attachments.
- No change to the editor, drag-and-drop, keyboard UX, or the `.nbx` format.
- No Firefox support for folder mode - it has no File System Access API. Server mode or
  manual `.nbx` for those users.
- No file locking, no share-level permissions - the drive's own ACLs decide who can write.

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Commons Clause blocks the use case | total | Phase 0, before code |
| UC2 violated routinely → `409` dialogs everywhere | high | start optimistic; soft lease is a ~30-line upgrade, keep the interface ready for it |
| Client and server both own `revision` → silent corruption | high | server assigns `rev`, client only sends `If-Match` via `meta.serverRev`; the two counters never mix |
| Board id collision across users | medium | monotonic `nextBoardId()` in-browser; a cross-user clash surfaces as a loud `409` on create, never a silent overwrite |
| Poll resurrects a locally deleted board | low | server tombstone answers `410`; client stops pushing that board |
| localStorage as cache grows unbounded (50 revs × boards) | low | `maxUndo` already caps it per board |
| Concurrent local edit + poll overwrite | high | `isBusyEditing()` guard, plus the editor never forces a render of a dirty board |
| Bodies are whole-board blobs; a 60 s-old client can clobber one field | medium | accepted at this cadence (UC2). Revisit only if dialogs become routine |

---

## Open questions

- Do users need to *see* each other's boards, or does each user only ever open their own?
  _Phase 2 pulls every board on the server into every client's list. Confirm that is what
  the team wants before it becomes a habit._
- Can anyone create a board, or only the owner? Who can delete someone else's board?
  _(Today: anyone with the token can do anything, including delete.)_
- Is 60 s the *maximum* staleness the team tolerates, or just a battery/log nicety?
  _(Push-on-save means the pull interval only affects how fast you see *their* changes.)_
- Should "keep mine" ever be allowed to clobber silently, or always branch into a new rev?

---

## Milestones

| Milestone | Ships | Est. | State |
|---|---|---|---|
| M0 | licence decision, go/no-go | 1 d | ✅ |
| M1 (Ph 1-2) | boards on a server, 60 s pull, push on save, offline-safe | 2.5-3.5 d | ✅ |
| M2 (Ph 3) | safe for people who don't take turns, four-way conflict dialog, tombstones | 1 d | ✅ |
| M3 (Ph 4) | board list metadata, debug flag, resolve link, team README | 1 d | ✅ |
| M4 (Ph 5) | offline/reconnect + two-browser tests | 0.5 d | ✅ |
| M5 (Ph 6) | shared-folder sync, no server process anywhere | 1 d | ✅ |


**~5-6 dev-days to a working multi-user board**, offline behaviour preserved. Roughly half
of that is spent; M1 is in.
