#!/usr/bin/env node
// Bake the default UI mode into package.json's `gitBranchViewDefaults.ui`
// field. The VSIX always includes all contributed UI modes; this value only
// decides which one opens by default when the user's `gitBranchView.ui`
// setting is left at "auto" (the default).
//
//   node scripts/configure-ui.js webview   # default to graph + columns
//   node scripts/configure-ui.js native    # default to built-in tree views
//   node scripts/configure-ui.js both      # default to both UIs together
//
// Used by the `package` npm script (which bakes `webview`). Users can still
// override the baked default at runtime via the `gitBranchView.ui` setting
// or the "Git Branches: Select UI Mode…" command.
'use strict';

const fs = require('fs');
const path = require('path');

const MODES = ['webview', 'native', 'both'];
const mode = process.argv[2];

if (!MODES.includes(mode)) {
  console.error(`Usage: node scripts/configure-ui.js <${MODES.join('|')}>`);
  process.exit(1);
}

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

pkg.gitBranchViewDefaults = { ...(pkg.gitBranchViewDefaults || {}), ui: mode };

// Preserve the file's 2-space indentation and trailing newline.
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Baked default UI mode → "${mode}" (package.json: gitBranchViewDefaults.ui)`);
