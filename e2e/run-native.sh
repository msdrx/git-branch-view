#!/usr/bin/env bash
# End-to-end check for the NATIVE tree-view UI of the Git Branch View.
#
# Same machinery as run-shots.sh (Xvfb + real VS Code + CDP), but seeds the
# isolated profile with `gitBranchView.ui: "native"` so the extension renders
# the built-in tree views, then drives them with drive-native.js. Output lands
# in ./shots/native-*.png.
#
# Env overrides: VSCODE_BIN, WORK_DIR, SHOTS_DIR, DISPLAY_NUM, CDP_PORT
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
SHOTS="${SHOTS_DIR:-$HERE/shots}"
WORK="${WORK_DIR:-$(mktemp -d -t gbv-native-XXXXXX)}"
DEMO="$WORK/branch-demo"
UD="$WORK/user-data"
EXT="$WORK/extensions"
DISPLAY_NUM="${DISPLAY_NUM:-:98}"
PORT="${CDP_PORT:-9223}"
export DISPLAY="$DISPLAY_NUM"

CODE_BIN="${VSCODE_BIN:-}"
if [ -z "$CODE_BIN" ]; then
  for c in /usr/share/code/code /usr/bin/code "$(command -v code 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CODE_BIN="$c"; break; fi
  done
fi
[ -z "$CODE_BIN" ] && { echo "ERROR: VS Code binary not found. Install it or set VSCODE_BIN."; exit 1; }
echo "using VS Code: $CODE_BIN"

if [ ! -d "$HERE/node_modules/playwright-core" ]; then
  echo "installing playwright-core..."
  ( cd "$HERE" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --silent )
fi

cleanup() {
  [ -n "${CODE_PID:-}" ] && kill "$CODE_PID" 2>/dev/null
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null
  # Always restore the committed default UI mode, even on failure.
  ( cd "$REPO_ROOT" && node scripts/configure-ui.js webview >/dev/null 2>&1 ) || true
}
trap cleanup EXIT

mkdir -p "$SHOTS" "$UD/User" "$EXT"

# Seed the profile — note gitBranchView.ui = native.
cat > "$UD/User/settings.json" <<'JSON'
{
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Light Modern",
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
  "git.openRepositoryInParentFolders": "always",
  "gitBranchView.ui": "native"
}
JSON

# Bake the native UI as the packaged default. This headless profile discards
# seeded user settings.json, so `gitBranchView.ui: native` can't be set that
# way — but the baked default needs no settings at all (the setting stays
# "auto" and resolves to native). The cleanup trap restores the webview default.
( cd "$REPO_ROOT" && node scripts/configure-ui.js native )

# Compile, then load the extension straight from source via
# --extensionDevelopmentPath at launch. A plain copy into --extensions-dir gets
# garbage-collected by VS Code 1.74+ unless it's registered in extensions.json,
# which is exactly what bit the first attempt here.
( cd "$REPO_ROOT" && npm run --silent compile )

bash "$HERE/make-repo.sh" "$DEMO"

pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null
pkill -f "remote-debugging-port=$PORT" 2>/dev/null
sleep 1
Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 2

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
# profile deletes the settings.json seeded before launch, but live-watches the
# file, so a post-launch write is picked up and applied (see run-shots.sh).
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
fi
sleep 3

SHOTS_DIR="$SHOTS" CDP_URL="http://127.0.0.1:$PORT" node "$HERE/drive-native.js"
RC=$?
echo "drive rc=$RC; screenshots in $SHOTS"
exit $RC
