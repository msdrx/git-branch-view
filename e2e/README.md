# Screenshot / E2E harness

Captures the screenshots in [`./shots/`](./shots) by running the
**real** extension inside **real** VS Code, headless. There is no mocking: VS
Code loads the compiled extension, the extension host shells out to `git`
against a synthetic repository, and the webview is driven through VS Code's own
Chromium via the Chrome DevTools Protocol (CDP).

## How it works

```
run-shots.sh
 ├─ make-repo.sh  → builds a synthetic git repo (branches, no-ff merge,
 │                  an origin remote with a teammate commit, ahead/behind)
 ├─ Xvfb          → virtual display so the GUI can render headless
 ├─ code …        → launches VS Code with --remote-debugging-port, an isolated
 │                  --user-data-dir/--extensions-dir, opened on the synth repo
 └─ drive.js      → connects over CDP (playwright-core), runs the
                    "Open Branch View" command, then dispatches the real
                    webview handlers and screenshots each view
```

Because clicks fire the actual DOM handlers, Compare and Commit Details cause
the extension host to run real `git` commands, and **New Branch** brings up
VS Code's native input box — all genuinely exercised.

## Prerequisites

- VS Code installed (the script auto-detects `/usr/share/code/code` or `code`
  on `PATH`; override with `VSCODE_BIN=/path/to/code`).
- Node.js (for `playwright-core`, installed automatically on first run).
- On Debian/Ubuntu:

  ```bash
  sudo apt-get install -y xvfb xauth xdotool
  ```

## Run

```bash
cd e2e
npm install        # first time only (installs playwright-core, no browser download)
npm run shots      # or: bash run-shots.sh
```

Images are written to `./shots/`.

Two sibling runs reuse the same machinery:

- `bash run-native.sh` — seeds the native UI mode and drives the built-in
  tree views with `drive-native.js` (`shots/native-*.png`).
- `bash run-both.sh` (or `npm run shots:both` from the repo root) — bakes the
  `both` UI default, verifies the native trees **and** the webview panel are
  active at the same time, then drives the "Git Branches: Select UI Mode…"
  QuickPick: asserts it offers Webview / Native / Both with the current mode
  marked, picks Native, and checks the `gitBranchView.ui` setting write plus
  the reload prompt (`shots/both-*.png`).

## Captured views

| File | View |
|------|------|
| `01-main-layout.png`          | Branch tree + commit graph with columns |
| `02-compare-branches.png`     | Compare `main ⇄ feature/payments` |
| `03-commit-details.png`       | Commit details (message, parents, changed files) |
| `04-branch-context-menu.png`  | Right-click branch menu |
| `05-commit-context-menu.png`  | Right-click commit menu |
| `06-branch-filtered-graph.png`| Graph filtered to one branch's history |
| `07-tree-filter.png`          | Live tree filter box |
| `08-new-branch-input.png`     | Native "New Branch" input box |

## Env overrides

`VSCODE_BIN`, `WORK_DIR`, `SHOTS_DIR`, `DISPLAY_NUM` (default `:99`),
`CDP_PORT` (default `9222`).
