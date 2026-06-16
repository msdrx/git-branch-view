# Contributing

This guide covers what you need to install, how to start the extension locally 
and which checks to run before you open a pull request.

## What you need

- VS Code.
- Node.js and npm.
- Git.
- A local Git repository to test the extension against.

For screenshot/e2e tests on Linux, you also need a headless display setup:

```bash
sudo apt-get install -y xvfb xauth xdotool
```

## Get the project ready

```bash
npm install
npm run compile
```

`npm install` installs the TypeScript, React, test, and VS Code extension
development dependencies. `npm run compile` builds both the extension host and
the webview bundle.

## Start development

For active development, run the watcher:

```bash
npm run watch
```

Then press **F5** in VS Code. This opens an Extension Development Host window
with your local version of the extension loaded.

In the Extension Development Host:

1. Open a folder that is a Git repository.
2. Open the Command Palette.
3. Run **Git Branches: Open Branch View**.

If you are working on UI mode behavior, run **Git Branches: Select UI Mode...**
and choose Webview, Native, or Both. VS Code asks for a reload because the
extension registers different views and commands for each mode.

## Useful scripts

```bash
npm run compile          # Build extension host and webview
npm run watch            # Rebuild while developing
npm test                 # Run unit tests once
npm run test:watch       # Run unit tests in watch mode
npm run shots            # Capture webview e2e screenshots
npm run shots:both       # Capture Both-mode e2e screenshots
npm run package          # Build a .vsix package
npm run install:dev      # Install the packaged extension locally
```

## Before opening a pull request

Run the checks that match your change:

- Documentation-only change: read the changed Markdown in preview.
- TypeScript or Git behavior change: run `npm test`.
- Webview change: run `npm test` and `npm run shots`.
- UI mode or Native tree view change: run `npm test` and `npm run shots:both`.
- Packaging change: run `npm run package`.

Also test the extension manually in the Extension Development Host. At minimum,
open a Git repository and confirm **Git Branches: Open Branch View** still
loads.

## Project layout

- `src/extension.ts`: extension activation, commands, UI mode selection, and
  file watchers.
- `src/git/`: Git CLI wrapper and shared Git actions.
- `src/panel/`: webview panel host code.
- `src/webview/`: React app for the visual graph view.
- `src/native/`: VS Code tree views for Native mode.
- `media/`: icon and screenshots.
- `scripts/`: build, package, and local install helpers.
- `e2e/`: screenshot and end-to-end harness.

## How it works

The extension has two front ends:

- **Webview**: a React-based panel with the branch tree, lane-drawn commit graph,
  compare view, and changed-file diffs.
- **Native**: built-in VS Code tree views named Branches and Commits.

Both front ends use the same extension host code and `GitService`. The extension
shells out to the `git` CLI directly instead of using VS Code's Git API, which
keeps graph output, compare ranges, and branch operations under this extension's
control.

The webview and extension host communicate with `postMessage`. The Native views
call the same Git actions directly from VS Code command handlers.
