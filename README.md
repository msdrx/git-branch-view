# Git Branch View

Git Branch View adds a branch browser and commit history view to VS Code.

Open a Git repository, then run **Git Branches: Open Branch View** from the
Command Palette.

## What you can do

- Browse local and remote branches.
- See the current branch, ahead/behind counts, commits, authors, dates, and
  commit IDs.
- Fetch, pull, push, or sync the checked-out branch.
- Checkout, create, merge, compare, and delete branches from context menus.
- Compare two branches and inspect the commits and changed files on each side.
- Click a commit file to open VS Code's diff editor.

## Command Palette

Search for **Git Branches** in the Command Palette:

- **Open Branch View** opens the selected view mode.
- **Refresh Branch View** reloads branch and commit data.
- **Select UI Mode...** switches between Webview, Native, and Both. Reload the
  VS Code window when prompted.

When Native or Both mode is enabled, additional **Git Branches** commands are
available from the Command Palette and context menus:

- **Fetch**, **Pull**, **Push**, **New Branch...**, and **Refresh**.
- **Set Pull Strategy...** chooses merge, rebase, or fast-forward-only pulls.
- Branch actions: **Checkout**, **Merge into Current Branch**, **Compare
  with...**, and **Delete Branch**.
- Commit actions: **Open Changes**, **Copy Commit ID**, **New Branch from
  Commit...**, **Checkout Commit (detached)**, and **Load More Commits**.

## View Modes

Use **Git Branches: Select UI Mode...** or the `gitBranchView.ui` setting.

- **Webview**: the default visual view, with a lane-drawn commit graph,
  resizable columns, branch tree, compare view, and changed-file diffs.
- **Native**: built-in VS Code tree views in the Activity Bar. This is simpler,
  theme-friendly, and accessible, but it does not draw the commit graph.
- **Both**: enables the Webview and Native tree views at the same time.

The default `auto` setting uses the mode packaged with the extension, currently
Webview.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, tests, packaging, and
architecture notes.

## Screenshot

![Branch view](https://github.com/msdrx/git-branch-view/blob/main/media/screenshot.png)

## License

MIT
