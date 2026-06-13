#!/usr/bin/env bash
# Sideload this extension into the dev container's VS Code Server so the
# "Git Branches: Open Branch View" command is available in the NORMAL editor
# window — no F5 / Extension Development Host required.
#
# Runs automatically from .devcontainer/devcontainer.json's postCreateCommand.
# Re-run by hand after editing the extension, then "Developer: Reload Window":
#     npm run install:dev
#
# Why this copies files AND edits extensions.json: since VS Code ~1.74 the
# server only loads extensions listed in <extensions-dir>/extensions.json. A
# plain folder copy is ignored. When you Uninstall from the VS Code UI it drops
# our entry from that manifest (and may mark the folder in `.obsolete`), so a
# copy-only reinstall silently does nothing — the symptom that prompted this.
# We therefore register the extension in the manifest exactly like a real
# install, which makes reinstall-after-delete work.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Extension id is <publisher>.<name>-<version>, read straight from package.json
# so it stays correct across version bumps. The path is passed as an argv (not
# interpolated into JS source, which would be code injection if it contained a
# quote), and the fields are validated below before being used in any path —
# the id ends up in an `rm -rf`, so it must never contain separators.
ID="$(node -p 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); `${p.publisher}.${p.name}-${p.version}`' "$ROOT/package.json")"
if ! printf '%s' "$ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
  echo "error: extension id '$ID' contains unsafe characters (check package.json publisher/name/version)" >&2
  exit 1
fi
case "$ID" in
  *..*) echo "error: extension id '$ID' must not contain '..'" >&2; exit 1 ;;
esac

# Locate the VS Code Server extensions dir (stable / insiders / legacy remote).
EXT_DIR=""
for d in "$HOME/.vscode-server" "$HOME/.vscode-server-insiders" "$HOME/.vscode-remote"; do
  if [ -d "$d/extensions" ]; then EXT_DIR="$d/extensions"; break; fi
done
EXT_DIR="${EXT_DIR:-$HOME/.vscode-server/extensions}"
DEST="$EXT_DIR/$ID"

echo "Compiling extension…"
( cd "$ROOT" && npm run --silent compile )

echo "Installing → $DEST"
mkdir -p "$EXT_DIR"
# Belt and braces before the destructive step: only ever delete a direct child
# of the extensions dir.
case "$DEST" in
  "$EXT_DIR"/*) ;;
  *) echo "error: refusing to remove '$DEST' (outside $EXT_DIR)" >&2; exit 1 ;;
esac
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$ROOT/out" "$ROOT/media" "$ROOT/package.json" "$DEST/"

# Register (or refresh) the extension in extensions.json so VS Code actually
# loads it, and un-mark it in .obsolete if a prior UI uninstall flagged it.
echo "Registering in $EXT_DIR/extensions.json"
node - "$EXT_DIR" "$ID" "$ROOT/package.json" <<'NODE'
const fs = require('fs');
const path = require('path');
const [extDir, folder, pkgPath] = process.argv.slice(2);
// Parse as data, never require() — require would execute code if the path
// ever resolved to a .js file.
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;            // identifier id (no version)
const dest = path.join(extDir, folder);               // absolute extension folder
const manifestPath = path.join(extDir, 'extensions.json');

// Read the existing manifest (an array); tolerate missing/corrupt files.
let list = [];
try {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Array.isArray(parsed)) list = parsed;
} catch { /* no manifest yet — start fresh */ }

// Drop any prior entry for this extension (any version), then add ours.
list = list.filter((e) => (e?.identifier?.id || '').toLowerCase() !== id.toLowerCase());
list.push({
  identifier: { id },
  version: pkg.version,
  // VS Code resolves extensions from relativeLocation; location is kept for
  // compatibility with older scanners that read the serialized URI.
  location: { $mid: 1, path: dest, scheme: 'file' },
  relativeLocation: folder,
  metadata: { source: 'vsix', isApplicationScoped: false, isMachineScoped: false, isBuiltin: false },
});
fs.writeFileSync(manifestPath, JSON.stringify(list, null, 2));

// Clear any obsolete marker so VS Code doesn't delete the folder on startup.
const obsoletePath = path.join(extDir, '.obsolete');
try {
  const obs = JSON.parse(fs.readFileSync(obsoletePath, 'utf8'));
  if (folder in obs) {
    delete obs[folder];
    fs.writeFileSync(obsoletePath, JSON.stringify(obs));
  }
} catch { /* no .obsolete file — nothing to clear */ }

console.log(`Registered ${id}@${pkg.version}`);
NODE

echo "Done. Run 'Developer: Reload Window' in VS Code to activate it,"
echo "then open a Git repo and run 'Git Branches: Open Branch View'."
