# Nullboard

Nullboard is a minimalist take on a kanban board / a task list manager, designed to be compact, readable and quick in use.

https://nullboard.io/preview

![Nullboard](images/nullboard-example-alt.png)

The name also happens to abbreviate to [NB](https://en.wikipedia.org/wiki/Nota_bene), which I think is a nice touch.

## Dead simple

* Single-page web app - just one HTML file. jQuery is inlined into it (see the note further
  down), the webfont pack in `extras/` is optional.
* Can be used completely offline. In fact, it's written exactly with this use in mind.

## Locally stored

* All data is stored locally, for now using [localStorage](https://developer.mozilla.org/en/docs/Web/API/Window/localStorage).
* The data can be exported to- or imported from a plain text file in a simple JSON format.
* The data can also be automatically backed up to a local disk with the help of:
  * [Nullboard Agent](https://nullboard.io/backups) - a native Windows app
  * [Nullboard Agent Express Port](https://github.com/justinpchang/nullboard-agent-express) - an express.js-based portable app
  * [nbagent](https://github.com/luismedel/nbagent) - a version for Unix systems, in Python

## Beta

Still very much in beta. Caveat emptor and all that.

## UI & UX

The whole thing is largely about making it convenient to use.

Everything is editable in place, all changes are saved automatically and last 50 revisions are kept for undo/redo:

![In-place editing](images/nullboard-inplace-editing.gif)

New notes can be quickly added directly where they are needed, e.g. before or after existing notes:

![Ctrl-add note](images/nullboard-ctrl-add-note.gif)

Notes can also be dragged around, including to and from other lists:

![Drag-n-drop](images/nullboard-drag-n-drop.gif)

Nearly all controls are hidden by default to reduce visual clutter to its minimum:

![Hidden controls](images/nullboard-hidden-controls.gif)

Longer notes can be collapsed to show just the first line, for even more compact view of the board:

![Collapsed notes](images/nullboard-collapsed-notes.gif)

The default font is [Barlow](https://tribby.com/fonts/barlow/) - it's both narrow *and* still very legible. Absolutely fantastic design!

![Barlow speciment](images/barlow-specimen.png)

Notes can also be set to look a bit different. This is useful for partitioning lists into sections:

![Raw notes](images/nullboard-raw-notes.gif)

Links starting with https:// and http:// are recognized. They will "pulse" on mouse hover and can be opened via the right-click menu.

![Links on hover](images/nullboard-links-on-hover.gif)

Pressing CapsLock will highlight all links and make them left-clickable.

![Links reveal](images/nullboard-links-reveal.gif)

Lists can be moved around as well, though not as flashy as notes:

![List swapping](images/nullboard-list-swap.gif)

The font can be changed; its size and line height can be adjusted:

![Theme and zoom](images/nullboard-ui-preferences.gif)

The color theme can be inverted:

![Dark theme](images/nullboard-dark-theme.gif)

Also:

* Support for multiple boards with near-instant switching
* Undo/redo for 50 revisions per board (configurable in the code)
* Keyboard shortcuts, including Tab'ing through notes

## Sync (this fork)

This fork adds an optional shared copy, so a team can see each other's boards. It stays an
offline-first app: localStorage is still the source of truth on your machine, and the shared
copy is something everyone reconciles with. There are three ways to share, and you only need
one of them: a shared folder, a sync server, or plain `.nbx` files dropped in a folder.

* Edits are saved locally first, then written to the shared copy immediately.
* Other people's changes are picked up every 60 seconds.
* Nothing blocks on the network - you can edit with the share unreachable and it catches up.
* If two people edit the same board, the second one gets a dialog instead of silently
  overwriting: **take theirs**, **keep mine**, **keep both** (mine becomes a new board), or
  **export mine** first.

### Shared folder - no server to run

Put `nullboard.html` on the shared drive and everyone opens it from there. That single file
is the whole app - jQuery is inlined, so nothing else has to load for it to work. `extras/`
only holds the webfonts; without it you get the system font instead of Barlow, which is
exactly why jQuery no longer lives there:

> Opened from a network location, Chrome can refuse to load `file://` subresources. The
> upstream build pulled jQuery from `code.jquery.com` when the local copy failed, which
> needs internet access and otherwise leaves a page where nothing responds and nothing says
> why. Inlined, a single file works from any share. If the app ever does fail to start, a red
> bar across the top says what went wrong instead of failing silently.

Open the config menu (the `≡` at the top right) → **Sync**, and fill in:

| Field | Meaning |
|---|---|
| Name | your tag - how your edits are attributed (see below) |
| **Choose shared folder...** | pick the folder on the share, e.g. `Z:\team boards` |

That is the whole setup. Each board becomes one file, `board-<id>.json`, in that folder:
everybody's boards show up in your board list, with who saved them last and a **stale** badge
for boards nobody has touched in a week. Delete a board and its file is removed.

Do not edit, rename or move those files by hand - the app is the only thing that should
write them.

**Expect one click when you open the app.** Browsers deliberately forget the folder grant
when a page is loaded again, so on every fresh load a blue bar appears at the top:

> Sync is off until you allow writing to "team boards". **Allow folder access**

One click on that (then *Allow* in the browser's own prompt) is enough - it re-uses the same
folder, you never have to pick it again. Until you do, sync stays off and the status line
says `folder access needs one click`. **Forget folder** stops using the folder entirely.

**This needs Chrome or Edge** - it uses the File System Access API, which Firefox does not
have. Firefox users should use a sync server instead, or Export/Import.

### No folder access? Drop a file instead

Some work machines refuse the folder picker outright - **Choose shared folder...** answers
`NotAllowedError ... not allowed by the user agent or the platform in the current context`,
and no amount of clicking fixes it, because a policy is saying no. For those machines the
team can work off plain files in the same shared folder, no picking required:

1. **Export all boards...** (config menu) writes one file, `nullboard-<your name>-<date>-<time>.nbx`.
   If this browser has no name stored (a wiped profile) it asks for one first, because the
   name is how the team tells whose drop it is.
2. Save it into the team folder, e.g. `Z:\team boards\`. The name and the time in it mean
   nobody's file ever overwrites anybody else's.
3. **Import boards...** takes as many of those files as you like - select them all in the
   file dialog - and merges them.

Merging goes by **last edit time**, not by revision: a board you already have is replaced
only by a copy edited *later* than yours, and an older copy is listed as `older` and left
alone. So importing the whole folder every morning cannot roll anyone back, and importing
your own export does nothing. Boards you do not have are added; a new board whose title you
already use gets ` (imported)` so the two can sit side by side.

In this mode there is no automatic sync - you drop a file when you want to be seen, and you
import when you want to see. Undo history and attribution still work; the conflict dialog
belongs to the folder and server modes.

### Sync server

A small server is included for teams who cannot use a folder (Firefox), or who would rather
have the shared copy on a machine than on the share. Zero dependencies, plain Node:

```sh
NB_TOKEN=<a shared secret> node server/server.js      # listens on 10001
```

`NB_DATA` sets where the JSON files live (default `server/data/`), `NB_PORT` the port. Then
in the app's Sync section set **Server** (`http://host:10001`) and **Token** (the
`NB_TOKEN` value). Anyone with the token can read, write and delete every board on it - it is
for a trusted team behind the LAN, not for the open internet.

Clear the folder (and the Server/Token fields) to turn sharing off again. Boards you import
with **Import boards...** are pushed to the shared copy straight away.

### Who edited what

Set **Name** in the Sync section once per browser - that is your tag on everything you
touch. Attribution then shows up in two places:

* the **board header** carries `last edit by <name>, 5 min ago`, updated on every save;
* **hover a note** and its author appears in the note's bottom-right corner; the note's
  tooltip carries the full text (`last edit by seppo, 2 h ago`).

A note is only re-attributed when its **text** actually changes - creating it or editing it.
Moving a note between lists, collapsing it or switching it to a raw note does not steal
authorship, and saving one note never relabels the rest of the board. Notes written before
this version have no author and show nothing.

The name lives in this browser's localStorage, so it is per browser profile, not per person:
if two people share a machine they share a name.

### Losing a board

The shared copy keeps one file per board, not a revision history. If someone else's version
wins over yours:

* if the overwrite happened on *this* machine, your version is still in the local undo
  history - `Ctrl-Z`, or the board menu's **Undo**;
* otherwise, restore from the last `.nbx` you exported (**Export all boards...**).

That is why the conflict dialog offers **Export mine first** and **Keep both**.

---

## Caveats

* Written for desktop and keyboard/mouse use
* Essentially untested on mobile devices and against tap/touch input
* Works in Firefox, tested in Chrome, should work in Safari and may work in Edge (or what it's called now)
* Uses localStorage for storing boards/lists/notes, so be careful around [clearing your cache](https://stackoverflow.com/questions/9948284/how-persistent-is-localstorage).
  If a machine wipes site data on every restart, folder sync has nothing to hold on to there -
  use **Import boards...** / **Export all boards...** instead, which need no stored state.

You spot a bug, file an issue.

## Dockerized version

See [this fork](https://github.com/rsoper/nullboard).

## Background

Nullboard is something that handles ToDo lists in the way that works really well. For *me* that is.

Tried a lot of options, some were almost *it*, but none was 100%.

**Trello** wasn't bad, but never was comfortable with the idea of storing my data in cloud without any actual need.

**Wekan** looked promising, but ultimately too heavy and had no offline usage support or a local storage option.

**Things** was beautiful, but not the right tool for the job.

**Inkscape** - I kid you not - with a laundry list of text items was actually OK, but didn't scale well.

Ditto for the plain **text files**.

Pieces of **paper** were almost there, but rearranging items can be quite a hassle.

So finally got annoyed enough to sit down and write exactly what I wanted.

And, voilà, Nullboard came out  =>  https://nullboard.io/preview

## License

The [2-clause BSD license](https://opensource.org/licenses/BSD-2-Clause/) with the [Commons Clause](https://commonsclause.com/).

That is, you can use, change and re-distribute it for as long as you don't try and sell it.

## Updates

Primary feed is through [@nullboard](https://twitter.com/nullboard) on Twitter.

The changelog is here => https://nullboard.io/changes
