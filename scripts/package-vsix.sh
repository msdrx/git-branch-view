#!/usr/bin/env bash
# Build a distributable .vsix for this extension — the portable unit you install
# on any desktop VS Code with `code --install-extension <file>.vsix` or the
# Extensions view → "Install from VSIX…".
#
# Unlike scripts/install-dev-extension.sh (which only sideloads into this dev
# container's VS Code Server), the .vsix produced here works on any machine.
#
# The version is the `version` field in package.json — the single source of
# truth that vsce embeds in the .vsix manifest.
#
# Usage:
#     npm run package                # package the current package.json version
#     npm run package -- patch       # bump (npm version) then package
#     npm run package -- minor
#     npm run package -- 1.3.0       # bump to an explicit version then package
#     bash scripts/package-vsix.sh 1.3.0
#
# An optional arg is forwarded to `npm version`, which writes package.json and
# creates a git commit + tag (it requires a clean working tree — commit your
# changes first). Omit it to package whatever version package.json already has.
#
# What ships is controlled by .vscodeignore and the allowlist verification near
# the end of this script. vsce runs `vscode:prepublish` automatically, so the
# bundled out/ is always freshly compiled with release settings.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Optional version bump: forward the arg to `npm version` (patch|minor|major or
# an explicit semver). This persists package.json and tags the release.
# Validate the arg first so it can't smuggle npm options (e.g. a leading "-")
# or arbitrary text into the command line.
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if [ "$#" -gt 0 ]; then
  case "$1" in
    patch|minor|major|prepatch|preminor|premajor|prerelease) ;;
    *)
      if ! printf '%s' "$1" | grep -Eq "$SEMVER_RE"; then
        echo "error: '$1' is not an npm version keyword or a semver version" >&2
        exit 1
      fi
      ;;
  esac
  echo "Bumping version → npm version $1"
  npm version "$1"
fi

# Read name/version from package.json without interpolating the path into JS
# source (a quote in the path would otherwise become code injection).
NAME="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name' "$ROOT/package.json")"
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$ROOT/package.json")"

# The output filename is built from package.json fields — validate them so a
# tampered manifest can't produce a path-traversal or option-looking filename.
if ! printf '%s' "$NAME" | grep -Eq '^[a-z0-9][a-z0-9._-]*$'; then
  echo "error: package.json 'name' ($NAME) is not a safe package name" >&2
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -Eq "$SEMVER_RE"; then
  echo "error: package.json 'version' ($VERSION) is not a valid semver version" >&2
  exit 1
fi
VSIX="${NAME}-${VERSION}.vsix"

# Pin vsce so npx can't silently pull a different (potentially compromised)
# release on every run; bump deliberately.
VSCE_VERSION="3.9.2"

echo "Packaging $VSIX (compiles via vscode:prepublish)…"
rm -rf out media/dist
# vsce rewrites the README's relative image link against the `repository` URL
# in package.json (→ https://github.com/<owner>/<repo>/raw/HEAD/media/…).
# That absolute HTTPS URL is the ONLY kind VS Code's extension-details page
# will render: its readme sanitizer strips relative paths, data: and file:
# URIs (verified empirically and in workbench.desktop.main.js). The image
# loads on the details page once the repo actually exists at that URL with
# media/screenshot.png committed — until then it 404s there but still renders
# on GitHub and in markdown previews of the source README.
npx --yes "@vscode/vsce@${VSCE_VERSION}" package \
  --out "$VSIX"

echo "Verifying VSIX contents…"
BAD_FILES=()
while IFS= read -r FILE; do
  case "$FILE" in
    "extension.vsixmanifest" | \
    "[Content_Types].xml" | \
    "extension/package.json" | \
    "extension/LICENSE.txt" | \
    "extension/readme.md" | \
    "extension/media/icon.svg" | \
    "extension/media/screenshot.png" | \
    "extension/media/dist/webview.css" | \
    "extension/media/dist/webview.js" | \
    extension/out/*.js | \
    extension/out/*/*.js)
      ;;
    *)
      BAD_FILES+=("$FILE")
      ;;
  esac
done < <(unzip -Z1 "$VSIX")

if [ "${#BAD_FILES[@]}" -ne 0 ]; then
  echo "error: VSIX contains files outside the release allowlist:" >&2
  printf '  %s\n' "${BAD_FILES[@]}" >&2
  exit 1
fi

MARKER_FOUND=0
while IFS= read -r FILE; do
  case "$FILE" in
    extension/media/dist/webview.js | extension/out/*.js | extension/out/*/*.js)
      if unzip -p "$VSIX" "$FILE" | grep -Eq 'sourceMappingURL|debugger;|eval\('; then
        MARKER_FOUND=1
      fi
      ;;
  esac
done < <(unzip -Z1 "$VSIX")

if [ "$MARKER_FOUND" -ne 0 ]; then
  echo "error: VSIX JavaScript contains sourcemap, debugger, or eval markers" >&2
  exit 1
fi

echo "VSIX contents verified: runtime JavaScript, bundled webview assets, media, README, and manifest only."

echo
echo "Done → $ROOT/$VSIX"
echo "Install with: code --install-extension \"$VSIX\""
