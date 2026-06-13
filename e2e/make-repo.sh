#!/usr/bin/env bash
# Build a synthetic git repo that exercises every Branch View UI feature:
# multiple authors, a no-ff merge, an origin remote with a teammate-only commit,
# ahead/behind tracking, and a diverged feature branch for the Compare view.
#
# Usage: make-repo.sh [DEMO_REPO_PATH]   (default: /tmp/demo/branch-demo)
set -euo pipefail

DEMO="${1:-/tmp/demo/branch-demo}"
ROOT="$(dirname "$DEMO")"
ORIGIN="$ROOT/origin.git"
CLONE="$ROOT/teammate-clone"

rm -rf "$ROOT"
mkdir -p "$DEMO"
cd "$DEMO"
git init -q -b main
git config user.name "Local Dev"
git config user.email "dev@example.com"

N=0
setauthor() {
  case "$1" in
    ada)   GIT_AUTHOR_NAME="Ada Lovelace";   GIT_AUTHOR_EMAIL="ada@example.com" ;;
    linus) GIT_AUTHOR_NAME="Linus Torvalds"; GIT_AUTHOR_EMAIL="linus@example.com" ;;
    grace) GIT_AUTHOR_NAME="Grace Hopper";   GIT_AUTHOR_EMAIL="grace@example.com" ;;
  esac
  export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
  export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
}
stamp() {
  N=$((N+1))
  local d; printf -v d "2024-02-%02d 10:%02d:00 +0000" "$N" "$N"
  export GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d"
}
mkc() { # who subject body file content
  setauthor "$1"; stamp
  mkdir -p "$(dirname "$4")"; printf "%s\n" "$5" >> "$4"; git add -A
  if [ -n "$3" ]; then git commit -q -m "$2" -m "$3"; else git commit -q -m "$2"; fi
}

# Workspace settings, committed so they don't dirty the tree (the extension's
# checkout/new-branch guard would otherwise trip on them — and anything VS Code
# rewrites in this file mid-run would too, so keep ONLY keys VS Code never
# touches: no workbench.colorTheme here, VS Code migrates renamed theme ids in
# place). Theme/dialog settings are applied at the user level by run-shots.sh
# AFTER launch, because the dev-mode profile discards the user settings.json
# seeded before startup.
mkdir -p .vscode
cat > .vscode/settings.json <<'JSON'
{
  "workbench.startupEditor": "none",
  "git.openRepositoryInParentFolders": "always"
}
JSON

# --- main line ---------------------------------------------------------------
mkc ada   "Initial project scaffolding" "Set up the repository skeleton and README." README.md "# Demo App"
mkc linus "Add core engine module"      ""                                            src/engine.js "export const run = () => 'ok';"
mkc grace "Set up CI pipeline"          "Run lint and tests on every push."           .github/ci.yml "on: [push]"
C2_ENGINE=$(git rev-parse HEAD~1)   # the engine commit, branch point for feature/login

# --- feature/login (will be merged back) ------------------------------------
git checkout -q -b feature/login "$C2_ENGINE"
mkc ada   "Add login form"          ""                                  src/login.js "export const form = () => {};"
mkc grace "Validate credentials"    "Reject empty passwords; trim usernames." src/login.js "// validation"

# --- continue main, then merge login with a real merge commit ----------------
git checkout -q main
mkc linus "Improve engine logging"  ""                                  src/engine.js "// log"
setauthor ada; stamp
git merge -q --no-ff feature/login -m "Merge feature/login into main" \
  -m "Brings in the login form and credential validation."
MERGE=$(git rev-parse HEAD)
setauthor grace; stamp

# --- feature/payments: diverges from the merge, never merged (for Compare) ---
git checkout -q -b feature/payments "$MERGE"
mkc grace "Add payment gateway"   "Integrate the external charge API."   src/pay.js "export const charge = () => {};"
mkc ada   "Handle refunds"        ""                                     src/pay.js "// refunds"

# --- main moves on independently (so it diverges from payments) --------------
git checkout -q main
mkc linus "Update user guide"     ""                                     docs/guide.md "## Usage"
mkc ada   "Refactor engine core"  "Split the engine into smaller units." src/engine.js "// refactor"

# --- release branch off the 1.0 merge ---------------------------------------
git branch release/1.0 "$MERGE"

# --- origin remote + push everything ----------------------------------------
git init -q --bare "$ORIGIN"
git remote add origin "$ORIGIN"
git push -q -u origin main feature/login feature/payments release/1.0
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main   # so clones default to main

# --- a teammate pushes a hotfix to origin/main (creates an INCOMING commit) --
git clone -q "$ORIGIN" "$CLONE"
( cd "$CLONE"
  git checkout -q main
  git config user.name "Grace Hopper"; git config user.email "grace@example.com"
  export GIT_AUTHOR_DATE="2024-02-20 09:00:00 +0000" GIT_COMMITTER_DATE="2024-02-20 09:00:00 +0000"
  printf "hotfix\n" >> HOTFIX.md; git add -A
  git commit -q -m "Hotfix: patch security advisory"
  git push -q origin main )

# bring the teammate's ref in (main is now BEHIND origin/main by 1)
git fetch -q origin

# --- two local commits on main NOT pushed (main is AHEAD of origin/main by 2)-
mkc grace "Add metrics collector" "" src/metrics.js "export const track = () => {};"
mkc ada   "Tune metrics sampling" "" src/metrics.js "// sampling"

git checkout -q main
echo "synthetic repo ready at: $DEMO"
git --no-pager status -sb | head -1
