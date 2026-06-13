#!/usr/bin/env node
/**
 * Bundle the React webview (src/webview/) into media/dist/ with esbuild.
 * The extension host loads media/dist/webview.js + webview.css (see
 * branchViewPanel.ts). `--watch` rebuilds on change (used next to
 * `tsc -watch` during development).
 */
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(__dirname, '..', 'src', 'webview', 'index.tsx')],
  outfile: path.join(__dirname, '..', 'media', 'dist', 'webview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2021',
  jsx: 'automatic',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
