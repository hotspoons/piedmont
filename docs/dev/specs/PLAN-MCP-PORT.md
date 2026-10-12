# Plan: porting `agent/mcp-fixes` into piedmont

**Status, 2026-10-12.** A branch from the arcade fixed nine findings an agent filed against the
editor's MCP tools (`program_*`, `code_*`, `shell_*`), plus a tenth commit making the shell start
itself. The branch was never merged in siomporas-arcade and is not in piedmont's import, so none of
it is here. This file records **which findings still reproduce against today's piedmont**, by
reading the current code, and the plan to port the survivors by intent.

- **Source:** `github.com/hotspoons/siomporas-arcade`, branch `agent/mcp-fixes`, tip
  `c4be424e695bcaed7885004db97245adfa4bd3be`. Two commits: `bf49e69` (the two filesystems, plus
  eight smaller findings) and `c4be424` (the shell starts itself).
- **Piedmont was imported from arcade `34933bd`; the branch forks earlier, at `4ca8fc6`.** The
  files changed a lot in between (arcade's `apps/<game>/src/agent/*` → `apps/game/src/agent/*`,
  `tools/` → `services/`), so **do not cherry-pick** — port each finding by intent, against today's
  code. Reference diffs: `git show bf49e69 -- <path>` / `git show c4be424 -- <path>`, with the path
  map below.

| Arcade path | Piedmont path |
|---|---|
| `apps/<game>/src/agent/bridge.ts` | `apps/game/src/agent/bridge.ts` |
| `apps/<game>/src/agent/lsp.ts` | `apps/game/src/agent/lsp.ts` |
| `apps/<game>/src/agent/shell.ts` | `apps/game/src/agent/shell.ts` |
| `apps/<game>/src/ui/shellpanel.ts` | `apps/game/src/editor/agent/shellpanel.ts` |
| `apps/<game>/src/worldedit/main.ts` | `apps/game/src/editor/worldedit/main.ts` |
| `tools/worldeditor/mcpbridge.mjs` | `services/worldeditor/mcpbridge.mjs` |
| `tools/worldeditor/mcpbridge.test.mjs` | `services/worldeditor/mcpbridge.test.mjs` |
| `tools/worldeditor/mcptools.mjs` | `services/worldeditor/mcptools.mjs` |
| `tools/worldeditor/server.mjs` | `services/worldeditor/server.mjs` |

## Which findings still reproduce

Read against today's tree, 2026-10-12.

| # | Finding | Today | Evidence |
|---|---|---|---|
| 1 | **CRITICAL.** A server-side write never reached the page: the shell served the copy it seeded at tab-open, so the next `sed -i` wrote stale text back, exit 0. Also the UI never repainted. | **Applies** | The bridge has no document channel — `mcpbridge.mjs` speaks only `register`/`claim`/`result`/`error`/`ownership`. `Shell.start()` seeds the mirror once and there is no `refresh()`; `Shell.changed()` only saves *outbound*. An `/api` write (a tool call) never touches it. |
| 2 | **CRITICAL.** `shell_exec` carried cwd between calls. | **Applies** | `shell.ts` `exec()`: `cwd0 = cwd \|\| this.cwd` and `if (r.cwd && !cwd) this.cwd = r.cwd`. `bridge.ts` passes `cwd` only when the caller gives one, so the machine's cwd leaks forward. |
| 3 | **HIGH.** `program_delete` on a folder without `recursive` answered `{"deleted":…}` and deleted nothing. | **Applies** | `store.removeProgram()` returns silently when `#programFile()` is null (a folder), and `server.mjs` returns `{ deleted: id }` unconditionally. A folder needs `?dir=1`. |
| 4 | **HIGH.** `code_hover`/`code_definition` on a cold language service returned `null`/`[]`. | **Obsolete** | `lsp.ts` `service()` already awaits `getTypeScriptWorker()` with a 10 s deadline *before* every hover/definition, and throws `"the TypeScript service never started"` on timeout — it can no longer report coldness as an empty success. |
| 5 | **MEDIUM.** Six schema/runtime contradictions: `code_typecheck` (no such tool), a path without its extension, cwd `/work`, "js" without node, the projection's extra `sites/` and `out/`, `shell_list` not saying it needs a page. | **Partial** | `code_typecheck` is named in `mcptools.mjs` `program_write` but the tools are `code_check`/`program_check`. `bridge.ts` `shell_exec` schema still says `default /work` (runtime root is `/workspace`). `shell_list` still does not say it needs a page. `shell_exec` lists `worlds/ levels/ programs/` but the projection also has `sites/` (and the README documents `out/`). **"js" is real here** (QuickJS in `apps/game/public/agent/worker.js`), so that one does not apply; the program-path extension is inconsistent (`program_read` says no extension, `program_check`'s example is `crofton/jam.ts`). |
| 6 | **MEDIUM.** `shell_list` mtime was the tab-attach time, identical for all files. | **Applies** | `worker.js` builds the listing from `walk(ROOT)` with `mtime: +new Date(st.mtime)`; those mtimes are set when the projection is *seeded at boot*, so every file shares one. No `projectedAt`. |
| 7 | **MEDIUM.** `code_outline` was longer than the file: imports and in-function locals included, children not in file order. | **Partial** | `lsp.ts` `outline()` walks `getNavigationTree` with no flags to drop imports or locals and no by-line sort. |
| 8 | **MEDIUM.** `code_definition` dead-ended on API symbols (added via `addExtraLib`): `line: null`. | **Applies** | `lsp.ts` `definition()` looks up `monaco.editor.getModel(d.fileName)`; an `addExtraLib` declaration has no model, so `at` is null and it returns `line: null, column: null` with nothing saying why. |
| 9 | **MEDIUM.** The same string was `id` from `program_list` and `path` everywhere else. | **Applies** | `program_list` is `/api/programs` → `store.listPrograms()` → `{ id, bytes, modified }`; every other program tool takes `path`. |
| 10 | **MEDIUM.** The shell starts itself; publishing it early was a race. | **Applies** | `bridge.ts` `needShell()` throws `"open the Shell tab once, then try again"`. `shellpanel.ts` boots only inside `render()` and `booting` returns *immediately* for a second caller (the exact race the commit fixed). `main.ts` `mcpConfig().catch(() => {})` still swallows the reason. |

**Seven of ten reproduce; two are obsolete or not defects here (1, 2, 3, 5-partial, 6, 7, 8, 9, 10
apply); #4 is handled by an await that is already in `lsp.ts`.**

**Ported 2026-10-12.** All nine live findings are implemented; the tests named under *Done when* pass
and `npx vitest run` is green. The one thing left is the real-browser check, which needs a browser.


## The port, by intent

1. **The document channel (#1).** The service already has `apiFetch` in `server.mjs`; make every
   mutating call broadcast which documents changed, in the page's vocabulary, to every attached
   page (`mcpbridge.mjs`). Add `Shell.refresh()` that pulls a document's text into the machine —
   read only, never saving back — and have the page repaint the world/level/program list. A shell
   `rm` propagates as a delete. An open Monaco buffer is left alone.
2. **Explicit cwd (#2).** Every `shell_exec` call takes a cwd, defaulting to `/workspace`, echoes
   it back, and never inherits. Fix the machine so `exec()` does not stash cwd behind the caller's
   back.
3. **Folder delete (#3).** `program_delete` without `recursive` on a folder must error and name the
   flag, not answer `{deleted}`.
4. **Schemas (#5).** `code_typecheck` → `code_check`/`program_check`; `/work` → `/workspace`;
   `shell_list` says it needs a page; the projection lists `sites/` and `out/`; make the program
   path's extension consistent.
5. **`projectedAt` (#6).** Carry each document's real projected time into the shell listing.
6. **Outline (#7).** Put imports and in-function locals behind flags; sort children by line.
7. **Definition (#8).** Count the position out of the lib text and return `declaration: true`.
8. **id/path (#9).** Return both from `program_list`.
9. **`ensureMachine()` (#10).** Public, idempotent, awaitable; one shared boot promise; pre-warm when
   the bridge attaches (not awaited, failure swallowed); guard the shared inspector pane; publish
   the machine only after its Worker starts; make `mcpConfig()` warn instead of swallowing.

## Done when

- [x] Each item above ported, or noted obsolete with the reason.
- [x] `services/worldeditor/mcpbridge.test.mjs` has both channel tests and they pass: a server-side
      write reaches every attached page, and an invalidation with nothing attached is a no-op, not a
      throw. (`documentsChanged` is tested beside them.)
- [x] A test proves the cwd does not leak (`shell_exec` always sends an explicit cwd, defaulting to
      `/workspace`) and one proves `program_delete` on a folder without `recursive` errors — the
      folder case is `services/worldeditor/program-delete.test.mjs`, failing before the store change
      and passing after.
- [x] `npx vitest run` from the root exits 0.
- [x] Checked in a real browser with the Shell tab never opened: `shell_exec` succeeds on the first
      call, the second reuses the machine, the visible pane is undisturbed, and opening the Shell tab
      afterwards shows the machine the agent started. Separately, an MCP-side `program_write` shows up
      in the page shell's `cat`. Verified 2026-10-12 by `services/worldeditor/mcp-browser-check.mjs`
      (13/13): a headless Chromium on `/world.html` against a local `server.mjs` (so nothing else owns
      the bridge), then `shell_exec`/`program_write`/`tools/list` over `POST /api/agent/mcp`. The
      machine came up pre-warmed on attach, so the first call was 120 ms rather than a cold ~7 s. The
      check also caught that a **stale `apps/game/dist`** still had the pre-`ensureMachine` bridge:
      the built app has to be current or the first call answers with the old "open the Shell tab
      once".

