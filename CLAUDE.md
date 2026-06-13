# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`git-branch-view`) that replaces VS Code's linear Source
Control view with a Visual Studio "Git Repository"–style window: a branch
tree on the left and a lane-drawn commit graph on the right, plus compare,
context menus, and incoming/outgoing fetch/pull/push.

The same git features ship behind **two interchangeable front-ends** (see "UI
modes" below): the original **webview** (the graph window) and a **native**
mode built from VS Code tree views. Both drive the same `GitService` and the
same `git/gitActions.ts` helpers, so they behave identically; they differ only
in rendering. The webview is the default.

## Commands

```bash
npm install
npm run compile      # tsc → out/, webview typecheck, esbuild → media/dist/
npm run watch        # esbuild --watch + tsc -w, used as the F5 preLaunchTask
npm run lint         # eslint src --ext ts
npm test             # vitest unit tests (no VS Code needed)
npm run shots        # e2e: real VS Code under Xvfb + screenshots + log dump
```

Run the extension: press **F5** in VS Code (launch config "Run Extension"). This
compiles, opens an Extension Development Host, then in that host open a Git repo
folder and run **"Git Branches: Open Branch View"** from the Command Palette
or the SCM view title bar.

Package a `.vsix`: `npm run package` — it bakes `both` as the default UI mode,
then packages. To bake a different default front-end first:

```bash
npm run configure-ui webview   # or native / both — just flips the baked
                               # default (no packaging), then run the
                               # package-vsix script directly
```

`scripts/configure-ui.js` writes `gitBranchViewDefaults.ui` in package.json;
that field is the default the packaged extension uses when the user's
`gitBranchView.ui` setting is left at `auto`. Every package ships *all*
front-ends regardless — the baked value only picks the out-of-the-box mode,
and installed users can switch any time with the "Git Branches: Select UI
Mode…" command (or the `gitBranchView.ui` setting).

Testing is three-tier:

- **Unit tests** (`npm test`): vitest + jsdom + @testing-library/react, config
  in `vitest.config.ts`. Tests live next to their modules
  (`src/**/*.test.ts(x)`); host-side modules that import `vscode` get the stub
  in `test/mocks/vscode.ts` via a resolve alias. `GitService` accepts an
  injectable exec function (third constructor arg) so parsing is tested against
  canned git output without spawning processes.
- **Real-git integration tests** (run with `npm test` too):
  `src/git/gitService.integration.test.ts` builds real repositories in temp
  dirs (fixture helpers isolate global/system git config and pin commit dates
  for deterministic ordering) and asserts `GitService` against actual git
  output — renames, merges, unicode/spaced paths, ahead/behind tracking,
  gone upstreams, detached HEAD, empty repos. When changing how change
  information is read or parsed, extend these, not just the canned tests.
- **E2E** (`npm run shots`): the screenshot harness in `e2e/` launches
  real VS Code headless under Xvfb, sideloads the compiled extension against a
  synthetic repo, and drives the live webview over the Chrome DevTools
  Protocol. It requires a `code` binary plus `xvfb xauth xdotool`. Screenshots
  land in `e2e/shots/` (light theme by default; one dark-theme shot), and the
  run's VS Code logs — main process, renderer, extension host, and the "Branch
  Manager" output channel — are dumped into `logs/` (gitignored).

## Architecture: two processes, one message channel

The extension is split across the VS Code **extension host** (Node) and a
**webview** (sandboxed browser). They share no memory and communicate *only*
through `postMessage`. Understanding this boundary is the key to the codebase.

```
Extension host (Node, src/)              Webview (React, src/webview/)
  extension.ts          activate, register commands, watch .git
  panel/branchViewPanel.ts  ──postMessage──▶  App.tsx    state + bridge
    owns the singleton webview  ◀──postMessage──  components/ tree, graph, menus
  git/gitService.ts     shells out to `git`      main.css   themed via VS Code
                                                            CSS variables
              esbuild bundles src/webview/ → media/dist/webview.{js,css}
```

- `src/extension.ts` — resolves the active UI mode (see below), registers
  `gitBranchView.open` / `.refresh` (which dispatch to whichever front-end is
  active), and a `FileSystemWatcher` on `**/.git/{HEAD,refs/**}` that
  auto-refreshes it on commits/checkouts/fetches.
- `src/panel/branchViewPanel.ts` — **webview mode.** Singleton
  (`BranchViewPanel.current`), one reused webview with
  `retainContextWhenHidden`. Builds the HTML (with a CSP nonce; scripts load
  only from `media/`), bridges messages, and triggers native VS Code UI (input
  box for new branch, modal confirm for delete).
- `src/git/gitService.ts` — every git interaction, **no `vscode` import.** One
  `GitService` per repo root, resolved via `git rev-parse --show-toplevel`.
- `src/git/gitActions.ts` — the VS Code-coupled write flows **shared by both
  front-ends**: the dirty-tree guard (`ensureClean`), push recovery
  (`pushWithRecovery` → publish / pull-then-push), and pull-strategy read/write.
  This is why the two UIs behave identically; touch it once, both follow.
- `src/webview/` — the **React webview** (TypeScript + TSX). Bundled by
  `scripts/build-webview.js` (esbuild) into `media/dist/webview.{js,css}` — a
  build artifact, gitignored; the committed media files are `media/icon.svg`
  and `media/screenshot.png` (the README screenshot, a copy of the e2e
  harness's `01-main-layout.png` — refresh it after UI changes). Layout: `App.tsx` (layout + message bridge + window-level effects),
  `state.ts` (a pure reducer over host messages and UI actions — the whole
  data flow is testable without React), `components/` (Toolbar, BranchPane,
  RightHeader, CommitList, ContextMenu), and framework-free modules
  `graph.ts` (lane layout), `columns.ts` (column defs + CSS-variable
  plumbing), `format.ts`, `types.ts` (the message contract), `vscodeApi.ts`
  (`acquireVsCodeApi` wrapper with a jsdom-safe stub). It has its own
  `tsconfig.json` (DOM lib + JSX, `noEmit`); the root tsconfig excludes it.
  **Keep the DOM ids/classes stable** (`#toolbar`, `#tree`, `#changes`,
  `#rows`, `#contextMenu`, `.commit-row`, `.tree-node`,
  `.file-node`, `.compare-section`, `.grid-cols`…) — `e2e/drive.js` and
  `main.css` are written against them.

  Clicking a commit row selects it and requests `commitDetail`; the response
  renders the commit's changed files as a collapsible directory tree
  (`#changes`, built by `buildFileTree()` in `BranchPane.tsx`) in the left
  pane below the branch tree, resizable from the `#hdivider` strip along its
  top edge. Selecting a file there posts `openFileDiff` and the host opens
  **VS Code's real diff editor in a split beside the panel** (`vscode.diff`,
  commit vs. first parent via `src/git/gitContentProvider.ts`, with
  `ViewColumn.Beside` + `preserveFocus` + `preview` so the Branch View keeps
  focus and one preview tab is reused across clicks; a missing side — root
  commit, add, delete — renders as a blank pane).

  **Branch compare works the same way** (the old `#overlay` slide-over is
  gone): a `compareResult` puts the changed files in the same `#changes` pane
  (header `base ⇄ target`) and swaps the right-hand list to two labelled
  sections (`.compare-section`) of ahead/behind commits, each row marked
  ↑/↓ in the graph column (no SVG graph in compare mode). Clicking a compared
  file opens the diff editor with the **merge-base** as the left side
  (`result.mergeBase`, computed by `GitService.compare`) so it matches the
  three-dot file list. Clicking a compare commit overlays its own files in
  the pane; ✕ peels back to the comparison, Escape or selecting a branch
  dismisses it entirely.

### UI modes (webview, native, or both)

The extension can render with either front-end — or both at once; the active
mode is chosen *once* at activation:

- The `gitBranchView.ui` setting (`auto` | `webview` | `native` | `both`).
  `auto` (the default) defers to the value baked into `package.json`
  (`gitBranchViewDefaults.ui`) by `scripts/configure-ui.js` at package time
  (committed as `webview`). The "Git Branches: Select UI Mode…" command
  (`gitBranchView.selectUi`) is a QuickPick that writes this setting globally.
- `extension.ts` sets two context keys: `gitBranchView.uiMode` (the resolved
  mode) and the boolean `gitBranchView.nativeEnabled` (true in `native` and
  `both`); the native views and their palette commands are contributed with
  `when: gitBranchView.nativeEnabled`, so in webview mode the whole
  activity-bar container stays hidden.
- In `both` mode the webview panel and the native tree views run side by side:
  `gitBranchView.open` targets the webview (the primary UI), the native views
  sit in the activity bar, and `gitBranchView.refresh` refreshes both. They
  share the `gitBranchView.focusedRef` workspaceState key, so whichever UI
  focused a branch last wins on the next refresh.
- Changing the setting prompts for a window reload (registration is one-shot).

**Native mode** lives in `src/native/` and uses built-in tree views — no
webview, no `media/`. It cannot draw the lane graph or resizable columns (the
reason the webview exists); instead it shows a flat commit list whose rows
expand to changed files that open real diff editors.

- `nativeBranchView.ts` — the controller. Mirrors the panel: resolves the
  repo, tracks the focused ref (same `gitBranchView.focusedRef`
  workspaceState key as the panel, so focus survives a mode switch), registers
  all `gitBranchView.native.*` commands, and refreshes both providers.
- `branchesProvider.ts` / `commitsProvider.ts` — the two `TreeDataProvider`s.
  Branch items carry `gbv.branch.{local,remote,local.current}` context values
  that drive the right-click menu `when` clauses in package.json. The Commits
  tree also has a **compare mode** (`setCompare`, cleared by the next
  `setCommits`/refresh): three sections — changed files (opening
  merge-base-vs-target diffs) plus the ahead/behind commits — mirroring the
  webview's compare.
- `src/git/gitContentProvider.ts` (shared, registered once in `extension.ts`
  for **both** UI modes) — a `TextDocumentContentProvider` for the
  `gitbranchview:` scheme that serves `git show <ref>:<path>` so `vscode.diff`
  can show commit-vs-parent (and compare) diffs.

Adding a native command touches three places: a `gitBranchView.native.*`
entry in `package.json` `contributes.commands`, a `menus` entry (`view/title`,
`view/item/context`, or `commandPalette: when:false` to hide node-only
commands), and a `registerCommand` in `nativeBranchView.ts`.

### The message protocol is the contract (webview mode)

Adding a feature almost always touches three places in lockstep:
1. a `case` in `handleMessage()` (`branchViewPanel.ts`) for the inbound type,
2. a method on `GitService`,
3. the webview: the message type in `src/webview/types.ts` and its handling in
   the reducer (`state.ts`) for the response.

Webview→host types: `ready`, `selectBranch`, `moreCommits`, `commitDetail`,
`openFileDiff`, `compare`, `checkout`, `createBranch`, `deleteBranch`, `merge`,
`fetch`, `pull`, `push`, `setPullStrategy`, `setColumnWidths`. Host→webview
types: `data`, `branchCommits`, `moreCommits`, `commitDetail`, `compareResult`,
`repo`, `error`. The webview sends `ready` on load to request the first `data`
payload; most write operations call `loadAll()` afterward to push a fresh
`data`. The bare `ready` keeps any restored branch focus; the Refresh button
sends `ready` with `reset: true` to clear it and follow the current branch.

**The commit list pages on scroll** (webview mode): `ready` carries a
`pageSize` (≈2× the rows that fit the window, computed in `App.tsx`); the host
remembers it and sends one page per load, with `hasMore` computed by fetching
`limit + 1` (`getPage()` in `branchViewPanel.ts`, `--skip` in
`GitService.getCommits`). Scrolling within one viewport of the bottom posts
`moreCommits { skip }` and the host appends the next page; the reducer drops a
page whose `skip` doesn't equal the loaded length (stale response after the
list was replaced). The host tracks `loadedCount` so refreshes re-fetch the
same depth (the list never shrinks under the user); `selectBranch` and
`ready reset:true` reset it to one page. Compare-mode lists don't page.

**Native mode pages too, but click-driven**: tree views expose no scroll
events, so `commitsProvider.ts` appends a trailing `loadMore` node ("Load more
commits…", running the `gitBranchView.native.loadMore` command) while more
history exists; `commitLimit` is the page size there. The controller mirrors
the panel: `loadedCount` keeps the depth across refreshes, focusing a branch
or Refresh resets to one page, `setLoadingMore()` disables the row while a
page is in flight.

### Persisted UI state

Two bits of view state outlive the panel, restored on reopen and across VS Code
restarts (neither uses `getState`/`setState`, which wouldn't survive a fresh
panel since no `WebviewPanelSerializer` is registered):

- **Column widths** — the commit-list columns (`Branch`/graph, `Message`,
  `Author`, `Date`, `ID`) are drag-resizable from header dividers. The webview
  (`columns.ts` + `CommitList.tsx`)
  drives the shared `.grid-cols` grid template through `--col-*` CSS variables
  and posts `setColumnWidths` on drag release; the host stores a sanitized map
  in `globalState` (`gitBranchView.columnWidths`) and echoes it back in every
  `data` payload. `Message` is the `1fr` filler until pinned, at which point the
  trailing spacer track becomes `1fr`; `Branch` never shrinks below the graph
  width (`max(var(--graph-col), …)`).
- **Focused branch** — the branch whose history is shown is saved per workspace
  in `workspaceState` (`gitBranchView.focusedRef`) via `setFocus()`, and
  restored in the constructor. `loadAll()` adopts HEAD as the baseline on the
  first load (so the restored focus survives) but still clears focus if HEAD
  later moves out from under it.

### Graph layout is computed in the webview

The host only sends commits with their parent hashes. `computeGraph()` in
`src/webview/graph.ts` assigns lanes and edges (first parent reclaims the
node's lane; other parents take free slots); `CommitList.tsx` draws nodes/edges
as an SVG overlay aligned to text rows by `LANE_W`/`ROW_H` constants. The host
never computes graph geometry.

## GitService conventions and gotchas

- **CLI, not the VS Code Git API** — deliberate, for full control over `git log`
  graph/format output and arbitrary compare ranges.
- **Output parsing uses control-byte separators**, not whitespace: NUL (`\x00`)
  between fields, RS (`\x1e`) between records — bytes that never appear in commit
  metadata or ref names. **The format-placeholder syntax differs per subcommand**:
  `git log --format` uses `%x00`/`%x1e`, but `git for-each-ref --format` uses
  `%00` (no `%x`). Never put a literal NUL in the command string — it truncates
  the shell command; the placeholders make *git* emit the real bytes.
- **Commands run through a shell** (`exec` with a single string). All
  user-derived arguments go through `quote()`. Exception: compare passes the
  `base..target` range unquoted so git parses the range operator, while
  `getCommits` quotes each ref individually.
- **Environment is pinned** to `GIT_PAGER=cat` and `LC_ALL=C` so output stays
  parseable regardless of user config/locale; `maxBuffer` is 64 MB.
- **Changed-file lists use `--name-status -z`** (NUL-separated), never the line
  format: with `-z` git emits paths verbatim, while the line format C-quotes
  anything non-ASCII under `LC_ALL=C` (`"na\303\257ve.txt"`), which would break
  both display and the `show ref:path` diff lookup. Rename/copy records carry
  two paths; `parseNameStatus` joins them as `old → new` (the webview and the
  diff opener split on that arrow).
- **Merge commits are diffed against their first parent** in `getCommitDetail`
  (`diff <hash>^ <hash>`), because `git show --name-status` on a merge emits
  the combined diff — empty for a clean merge, which would render the Changes
  pane as "No file changes". Root commits (no parent) keep using `show`, which
  diffs against the empty tree.

## Configuration

- `gitBranchView.ui` (default `auto`; `auto` | `webview` | `native` | `both`)
  — which front-end renders (`both` = webview panel + native trees together).
  `auto` defers to the packaged default (`gitBranchViewDefaults.ui` in
  package.json). Resolved by `resolveUiMode()` in `extension.ts`; changing it
  prompts for a window reload. Settable via the "Git Branches: Select UI
  Mode…" QuickPick command. See "UI modes".
- `gitBranchView.commitLimit` (default 500) — the **native** commit list's
  page size (a "Load more commits…" row pages in the rest). The webview
  ignores it: its list pages in on scroll (see "The commit list pages on
  scroll" above) all the way through the history.
- `gitBranchView.dateFormat` — **declared in package.json but not yet wired
  up**; `formatDate()` in `src/webview/format.ts` always uses the local format.
  Implement the read if you touch date display.
- `gitBranchView.pullStrategy` (default `merge`; `merge` | `rebase` |
  `ff-only`) — how `git pull` reconciles divergent branches. Read by
  `getPullStrategy()` in `git/gitActions.ts` (shared by both front-ends) and
  passed as an explicit flag (`--no-rebase` / `--rebase` / `--ff-only`) on every
  `pull`, so a divergent branch never trips git's "specify how to reconcile"
  fatal. Chosen from the Pull split-button caret (webview) or the Set Pull
  Strategy command (native); `setPullStrategy()` writes it to the global config
  so it sticks for future pulls.
