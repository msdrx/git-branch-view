# Git Branch View

Simple Git branch view extension for VS Code

## Features

- **Branch tree** with local/remote groups, ahead-behind badges, and the
  current branch highlighted.
- **Commit graph** with columns (Branch · Message · Author · Date · ID), sticky
  headers, and ref chips.
- **Fetch · Pull · Push · Sync** for incoming/outgoing changes.
- **Context menus**: checkout, new branch, merge, compare, delete, copy ID.
- **Compare branches** to see commits unique to each side and the changed files.
- **Click a commit** to view its changed files and open VS Code's real diff
  editor beside the panel.
- Auto-refreshes when the repo's branches or HEAD change.

## Develop & run

```bash
npm install
npm run compile      # or: npm run watch
```

Press **F5** to launch the Extension Development Host. In that window, open a
Git repository and run **“Git Branches: Open Branch View”** from the Command
Palette.

## Test & package

```bash
npm test             # unit tests (vitest)
npm run shots        # e2e screenshots (real VS Code under Xvfb)
npm run package      # build a .vsix
```

## How it works

The extension runs in two parts that talk over `postMessage`: a Node **extension
host** that shells out to the `git` CLI, and a **React webview** that draws the
branch tree and graph. It uses the CLI directly (not VS Code's Git API) for full
control over `git log` graph output and arbitrary compare ranges.

## 
![Branch view](https://github.com/msdrx/git-branch-view/blob/main/media/screenshot.png)

## License

MIT
