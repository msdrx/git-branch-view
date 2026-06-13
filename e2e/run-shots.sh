#!/usr/bin/env bash
# End-to-end screenshot harness for the Git Branch View extension.
#
# Starts a virtual display (Xvfb), launches REAL VS Code with a remote-debugging
# port, sideloads this extension into an isolated profile opened on a synthetic
# git repo, then drives the webview over CDP (via drive.js) to capture the
# screenshots in ./shots/.
#
# Prerequisites (Debian/Ubuntu): a working `code` install plus
#   sudo apt-get install -y xvfb xauth xdotool
# Node is needed for playwright-core (installed automatically on first run).
#
# Env overrides: VSCODE_BIN, WORK_DIR, SHOTS_DIR, DISPLAY_NUM, CDP_PORT
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
SHOTS="${SHOTS_DIR:-$HERE/shots}"
WORK="${WORK_DIR:-$(mktemp -d -t gbv-shots-XXXXXX)}"
DEMO="$WORK/branch-demo"
UD="$WORK/user-data"
EXT="$WORK/extensions"
DISPLAY_NUM="${DISPLAY_NUM:-:99}"
PORT="${CDP_PORT:-9222}"
export DISPLAY="$DISPLAY_NUM"

# --- locate the VS Code binary ----------------------------------------------
CODE_BIN="${VSCODE_BIN:-}"
if [ -z "$CODE_BIN" ]; then
  for c in /usr/share/code/code /usr/share/code-insiders/code-insiders "$(command -v code 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CODE_BIN="$c"; break; fi
  done
fi
[ -z "$CODE_BIN" ] && { echo "ERROR: VS Code binary not found. Install it or set VSCODE_BIN."; exit 1; }
echo "using VS Code: $CODE_BIN"

# --- ensure playwright-core is installed ------------------------------------
if [ ! -d "$HERE/node_modules/playwright-core" ]; then
  echo "installing playwright-core..."
  ( cd "$HERE" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --silent )
fi

# Dump the run's VS Code logs into the project folder (<repo>/logs/): the main
# process stdout/stderr, Xvfb, and the profile's logs/ tree — renderer +
# extension host logs and every output channel, including our "Branch View"
# LogOutputChannel (each git command + duration). Runs in the EXIT trap so
# failed runs leave logs behind too.
LOGS_OUT="$REPO_ROOT/logs"
dump_logs() {
  rm -rf "$LOGS_OUT"
  mkdir -p "$LOGS_OUT"
  cp "$WORK/code.log" "$LOGS_OUT/" 2>/dev/null
  cp "$WORK/xvfb.log" "$LOGS_OUT/" 2>/dev/null
  if [ -d "$UD/logs" ]; then
    cp -r "$UD/logs" "$LOGS_OUT/vscode-logs"
  fi
  echo "VS Code logs dumped to $LOGS_OUT"
}

cleanup() {
  [ -n "${CODE_PID:-}" ] && kill "$CODE_PID" 2>/dev/null
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null
  dump_logs
  # Restore the UI default that was baked into package.json before the run.
  if [ -n "${BAKED_UI:-}" ]; then
    ( cd "$REPO_ROOT" && node scripts/configure-ui.js "$BAKED_UI" >/dev/null 2>&1 ) || true
  fi
}
trap cleanup EXIT

mkdir -p "$SHOTS" "$UD/User" "$EXT"

# --- seed an isolated profile for clean, deterministic screenshots ----------
cat > "$UD/User/settings.json" <<'JSON'
{
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Light Modern",
  "gitBranchView.ui": "webview",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "workbench.tips.enabled": false,
  "workbench.enableExperiments": false,
  "window.commandCenter": false,
  "window.menuBarVisibility": "compact",
  "window.dialogStyle": "custom",
  "editor.minimap.enabled": false,
  "git.openRepositoryInParentFolders": "always"
}
JSON

# --- compile + load the extension straight from source ----------------------
# A plain copy into --extensions-dir gets garbage-collected by VS Code 1.74+
# unless it's registered in extensions.json (this bit run-native.sh first) —
# load via --extensionDevelopmentPath instead. Bake the webview front-end as
# the packaged default for the run (the dev-mode profile can drop seeded user
# settings), restoring whatever was baked before on exit.
BAKED_UI="$(node -p "require('$REPO_ROOT/package.json').gitBranchViewDefaults.ui")"
( cd "$REPO_ROOT" && node scripts/configure-ui.js webview )
( cd "$REPO_ROOT" && npm run compile )

# --- build the synthetic repo ------------------------------------------------
bash "$HERE/make-repo.sh" "$DEMO"

# --- start Xvfb --------------------------------------------------------------
pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
sleep 1
Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 2

# --- launch VS Code ----------------------------------------------------------
"$CODE_BIN" \
  --no-sandbox --disable-setuid-sandbox --disable-gpu --disable-dev-shm-usage \
  --disable-workspace-trust \
  --user-data-dir="$UD" --extensions-dir="$EXT" \
  --extensionDevelopmentPath="$REPO_ROOT" \
  --remote-debugging-port="$PORT" \
  "$DEMO" >"$WORK/code.log" 2>&1 &
CODE_PID=$!
echo "code pid=$CODE_PID"

echo "waiting for CDP endpoint on $PORT..."
CDP_UP=0
for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then echo "CDP up after ${i}s"; CDP_UP=1; break; fi
  sleep 1
done
[ "$CDP_UP" = 0 ] && { echo "CDP never came up"; tail -20 "$WORK/code.log"; exit 1; }

# Re-seed the user settings now that VS Code is up: the extension-development
# profile DELETES the settings.json seeded before launch, but it live-watches
# the file, so a post-launch write is picked up and applied. This is the only
# reliable way to set application-scoped settings here — window.dialogStyle
# (scope: application) cannot come from workspace settings, and without
# "custom" the delete-branch confirm is a native OS dialog that CDP can
# neither await nor screenshot. Theme ids are the post-1.8x names ("Light
# Modern", not "Default Light Modern").
mkdir -p "$UD/User"
cat > "$UD/User/settings.json" <<'JSON'
{
  "workbench.colorTheme": "Light Modern",
  "window.dialogStyle": "custom",
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "workbench.tips.enabled": false,
  "window.commandCenter": false,
  "editor.minimap.enabled": false,
  "git.openRepositoryInParentFolders": "always"
}
JSON
sleep 3

# size + focus the (unmanaged) window. VS Code's command palette auto-hides
# when the window is not focused, so X input focus is essential here.
sleep 6
WID=""
for i in $(seq 1 15); do
  WID=$(xdotool search --onlyvisible --class "code" 2>/dev/null | tail -1)
  [ -z "$WID" ] && WID=$(xdotool search --name "Visual Studio Code" 2>/dev/null | tail -1)
  [ -n "$WID" ] && break
  sleep 1
done
echo "window id=${WID:-NONE}"
if [ -n "${WID:-}" ]; then
  xdotool windowsize "$WID" 1600 1000 2>/dev/null
  xdotool windowmove "$WID" 0 0 2>/dev/null
  xdotool windowmap "$WID" 2>/dev/null
  xdotool windowactivate --sync "$WID" 2>/dev/null || true
  xdotool windowfocus --sync "$WID" 2>/dev/null || true
  echo "geometry: $(xdotool getwindowgeometry "$WID" 2>/dev/null | tr '\n' ' ')"
else
  echo "WARNING: VS Code window not found; keyboard focus may fail."
fi
sleep 3

# --- drive the UI and capture screenshots -----------------------------------
# DRIVE_JS overrides the driver script (e.g. check-buttons.js for the toolbar
# button functional checks); DEMO_DIR lets drivers mutate the synthetic repo.
SHOTS_DIR="$SHOTS" CDP_URL="http://127.0.0.1:$PORT" DEMO_DIR="$DEMO" \
  USER_SETTINGS="$UD/User/settings.json" node "${DRIVE_JS:-$HERE/drive.js}"
RC=$?
echo "drive rc=$RC; screenshots in $SHOTS"
exit $RC
