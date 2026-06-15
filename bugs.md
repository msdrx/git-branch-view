# Bugs Found

Static review plus the existing verification suite found these likely defects. No fixes are included here.

Verification run:

- `npm test` passed: 178 tests across 10 files.
- `npm run compile` passed.

## Findings

### High: branch identity is passed around as short names

The UI sends `b.name` instead of the full ref name for branch selection and actions. This affects webview selection, compare, checkout, merge, delete, and branch creation from a branch, plus the native UI's equivalent actions.

Relevant code:

- `src/webview/components/ContextMenu.tsx`
- `src/webview/App.tsx`
- `src/native/nativeBranchView.ts`

Impact: unusual but legal local/remote name collisions can target the wrong ref or become ambiguous. The code also loses whether the clicked item was local or remote.

### High: async host responses can overwrite newer UI state

The reducer accepts `branchCommits`, `commitDetail`, and `compareResult` without checking whether the response still matches the current selection/request.

Relevant code:

- `src/webview/state.ts`

Impact: fast clicks or slow git commands can show commits, changed files, or compare results for a previously selected branch/commit/compare.

### High: paths containing ` -> ` style rename separators are ambiguous

Rename records are flattened into a display string using the arrow separator, and later code splits any path containing that separator as if it were a rename.

Relevant code:

- `src/git/gitService.ts`
- `src/panel/branchViewPanel.ts`
- `src/native/nativeBranchView.ts`
- `src/webview/components/BranchPane.tsx`

Impact: a real file path containing the separator text is misinterpreted as a rename and can open the wrong diff.

### Medium: tracking counts are for the current branch, not the displayed branch

The webview always fetches `git.getTracking()`, which reports the current branch's upstream status, then displays those counts in the header for whichever branch history is focused.

Relevant code:

- `src/panel/branchViewPanel.ts`
- `src/webview/state.ts`
- `src/webview/components/RightHeader.tsx`

Impact: viewing another branch can show incorrect incoming/outgoing counts. Header pull/push/sync actions also operate on the current branch, not necessarily the displayed branch.

### Medium: `gitBranchView.dateFormat` is contributed but unused

The setting exists in `package.json`, but source code never reads it. The webview formatter always renders local date/time.

Relevant code:

- `package.json`
- `src/webview/format.ts`

Impact: changing the setting has no visible effect.

### Medium: repository selection is cached forever and always picks the first repo

Both webview and native paths resolve the first workspace folder that is a Git repository and cache the resulting `GitService`.

Relevant code:

- `src/panel/branchViewPanel.ts`
- `src/native/nativeBranchView.ts`

Impact: multi-root workspaces ignore the active editor/repo. If workspace folders or repository context change, the extension does not re-resolve.

### Medium: Git worktrees and packed refs are not reliably auto-refreshed

The extension watches only `**/.git/{HEAD,refs/**}`.

Relevant code:

- `src/extension.ts`

Impact: worktrees often have `.git` as a file pointing elsewhere, and ref updates can land in `packed-refs`; those changes may be missed until manual or focus-triggered refresh.

### Low: diff content errors are silently shown as blank files

`getFileAtRef` catches all errors and returns an empty string. The content provider therefore cannot distinguish missing files from other git failures.

Relevant code:

- `src/git/gitService.ts`
- `src/git/gitContentProvider.ts`

Impact: ambiguous refs, bad roots, permission issues, or other git errors can render as blank diff panes.

### Low: command activation relies only on startup activation

The extension uses `onStartupFinished`, but does not declare direct activation events for commands such as `gitBranchView.open`, `gitBranchView.refresh`, or `gitBranchView.selectUi`.

Relevant code:

- `package.json`

Impact: invoking commands before startup activation depends on VS Code startup timing instead of direct command activation.
