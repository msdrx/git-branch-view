// Drives real VS Code (over CDP) to exercise the NATIVE tree-view UI
// (gitBranchView.ui = "native"): opens the Git Branches activity-bar
// container, verifies the Branches + Commits tree views render real data,
// expands a commit to its changed files, opens a file diff, and opens a branch
// context menu — capturing a screenshot at each step into ./shots/.
//
// Unlike drive.js (which drives the webview inside an iframe), the native views
// live directly in the workbench DOM, so everything is queried on the main page.
const { chromium } = require('playwright-core');

const SHOTS = process.env.SHOTS_DIR || `${__dirname}/shots`;
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function allPages(browser) {
  const out = [];
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) out.push(p);
  return out;
}
async function findWorkbench(browser, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const p of allPages(browser)) {
      let url = ''; try { url = p.url(); } catch {}
      if (url.includes('workbench')) { try { if (await p.$('.monaco-workbench')) return p; } catch {} }
    }
    await sleep(500);
  }
  throw new Error('workbench page not found');
}
const paletteVisible = (wb) => wb.evaluate(() => {
  const w = document.querySelector('.quick-input-widget');
  if (!w) return false;
  const s = getComputedStyle(w);
  return s.display !== 'none' && s.visibility !== 'hidden' && w.getBoundingClientRect().height > 0;
});
async function runCommand(wb, text) {
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    try { await wb.bringToFront(); } catch {}
    await wb.mouse.click(800, 500);
    await sleep(300);
    await wb.keyboard.press('Control+Shift+P');
    await sleep(900);
    opened = await paletteVisible(wb);
    if (!opened) { await wb.keyboard.press('F1'); await sleep(900); opened = await paletteVisible(wb); }
  }
  if (!opened) throw new Error('command palette did not open');
  await wb.keyboard.type(text, { delay: 25 });
  await sleep(1000);
  await wb.keyboard.press('Enter');
  console.log('ran command:', text);
}
async function dismissOnboarding(wb) {
  const present = () => wb.evaluate(() => !!document.querySelector('[class*="onboarding-a-"], .gettingStartedContainer')).catch(() => false);
  for (let i = 0; i < 12 && !(await present()); i++) await sleep(500);
  for (let i = 0; i < 12 && (await present()); i++) {
    try {
      const x = wb.locator('[class*="onboarding-a-"] .codicon-close, .codicon-dialog-close, [aria-label="Close Dialog"]');
      if (await x.count()) { await x.first().click({ timeout: 2000 }); await sleep(900); continue; }
    } catch {}
    try {
      const skip = wb.locator('text=Continue without Signing In');
      if (await skip.count()) { await skip.first().click({ timeout: 2000 }); await sleep(900); continue; }
    } catch {}
    await wb.keyboard.press('Escape'); await sleep(700);
  }
  console.log((await present()) ? 'WARNING: onboarding still present' : 'onboarding handled');
}

// Inspect a sidebar tree view (pane) by its header title; return its visible rows.
function paneState(wb, titleRe) {
  return wb.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const pane = [...document.querySelectorAll('.pane')].find(
      (p) => rx.test(((p.querySelector('.pane-header .title') || {}).textContent || ''))
    );
    if (!pane) return { found: false };
    const rows = [...pane.querySelectorAll('.monaco-list-row')].map((r) => r.textContent.trim());
    return { found: true, rows };
  }, titleRe);
}
// Center coordinates of the Nth visible row in a named pane (for real clicks).
function rowCenter(wb, titleRe, index) {
  return wb.evaluate(({ src, idx }) => {
    const rx = new RegExp(src, 'i');
    const pane = [...document.querySelectorAll('.pane')].find(
      (p) => rx.test(((p.querySelector('.pane-header .title') || {}).textContent || ''))
    );
    if (!pane) return null;
    const row = [...pane.querySelectorAll('.monaco-list-row')][idx];
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + 36), y: Math.round(r.top + r.height / 2), text: row.textContent.trim() };
  }, { src: titleRe, idx: index });
}
const menuOpen = (wb) => wb.evaluate(() =>
  !!document.querySelector('.context-view .monaco-menu .action-item, .monaco-menu-container .action-item'));

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const wb = await findWorkbench(browser);
  console.log('workbench:', wb.url());
  try { await wb.bringToFront(); } catch {}
  await wb.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await sleep(3000);

  await dismissOnboarding(wb);
  await sleep(800);

  // Close the Chat secondary side bar for cleaner, wider screenshots.
  const auxBarWidth = () => wb.evaluate(() => {
    const el = document.querySelector('.part.auxiliarybar');
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  for (let i = 0; i < 4 && (await auxBarWidth()) > 5; i++) {
    await wb.mouse.click(800, 500); await sleep(200);
    await wb.keyboard.press('Control+Alt+B'); await sleep(800);
  }
  try { await runCommand(wb, 'View: Close All Editors'); } catch (e) { console.log('close-welcome:', e.message); }
  await sleep(800);

  const shot = async (name) => { await wb.screenshot({ path: `${SHOTS}/${name}` }); console.log('saved', name); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.error('STEP FAILED', name, e.message); } };

  // Diagnostics: what's in the activity bar and the sidebar right now?
  const dumpUi = () => wb.evaluate(() => ({
    activityBar: [...document.querySelectorAll('.activitybar .action-item')]
      .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean),
    paneTitles: [...document.querySelectorAll('.part.sidebar .pane')]
      .map((p) => ((p.querySelector('.pane-header .title') || p.querySelector('.pane-header') || {}).textContent || '').trim()),
    sidebarTitle: ((document.querySelector('.part.sidebar .composite.title .title-label') || {}).textContent || '').trim(),
  }));
  console.log('UI before open:', JSON.stringify(await dumpUi()));

  // Open the native Git Branches container via the user-facing command (this
  // also exercises extension.ts's mode dispatch → NativeBranchView.reveal()).
  await runCommand(wb, 'Git Branches: Open Branch View');
  await sleep(2500);
  console.log('UI after command:', JSON.stringify(await dumpUi()));
  await shot('native-debug-after-open.png');

  // Fallback: click the activity-bar icon for our container directly.
  const clickedIcon = await wb.evaluate(() => {
    const it = [...document.querySelectorAll('.activitybar .action-item')]
      .find((e) => /Git Branches/i.test(e.getAttribute('aria-label') || ''));
    if (!it) return false;
    (it.querySelector('a, .action-label') || it).click();
    return true;
  });
  console.log('clicked activity-bar icon:', clickedIcon);
  await sleep(2000);
  console.log('UI after icon click:', JSON.stringify(await dumpUi()));

  // --- core verification: both tree views render real data -------------------
  let branches, commits;
  for (let i = 0; i < 30; i++) {
    branches = await paneState(wb, 'Branches');
    commits = await paneState(wb, 'Commits');
    if (branches.found && commits.found && branches.rows.length && commits.rows.length) break;
    await sleep(500);
  }
  console.log('BRANCHES pane:', JSON.stringify(branches));
  console.log('COMMITS  pane:', JSON.stringify(commits));
  await shot('native-debug-final.png');
  if (!branches.found) throw new Error('Branches view did not appear');
  if (!commits.found) throw new Error('Commits view did not appear');
  if (!branches.rows.length) throw new Error('Branches view rendered no rows');
  if (!commits.rows.length) throw new Error('Commits view rendered no rows');
  console.log(`OK: ${branches.rows.length} branch rows, ${commits.rows.length} commit rows`);

  await step('01', () => shot('native-01-overview.png'));

  // --- expand a commit to reveal its changed files ---------------------------
  await step('02', async () => {
    const c = await rowCenter(wb, 'Commits', 0);
    if (!c) throw new Error('no commit row');
    console.log('clicking commit:', c.text);
    await wb.mouse.click(c.x, c.y);                 // toggles expansion (no command)
    await sleep(1800);
    const after = await paneState(wb, 'Commits');
    console.log('COMMITS after expand:', JSON.stringify(after.rows.slice(0, 6)));
    await shot('native-02-commit-files.png');
  });

  // --- open a file diff (commit vs parent) -----------------------------------
  await step('03', async () => {
    // After expansion the file rows are indented children directly below row 0.
    const f = await rowCenter(wb, 'Commits', 1);
    if (!f) throw new Error('no file row to open');
    console.log('clicking file:', f.text);
    await wb.mouse.click(f.x, f.y);
    await sleep(2000);
    const editor = await wb.evaluate(() => ({
      diff: !!document.querySelector('.monaco-diff-editor'),
      tab: ((document.querySelector('.tabs-container .tab.active') || {}).textContent || '').trim(),
    }));
    console.log('diff editor open:', JSON.stringify(editor));
    await shot('native-03-file-diff.png');
  });

  // --- branch context menu (right-click a branch row) ------------------------
  await step('04', async () => {
    // Row 0 of Branches is the "Local" group header; the first branch is row 1.
    const b = await rowCenter(wb, 'Branches', 1);
    if (!b) throw new Error('no branch row');
    console.log('right-clicking branch:', b.text);
    await wb.mouse.click(b.x, b.y, { button: 'right' });
    for (let i = 0; i < 20 && !(await menuOpen(wb)); i++) await sleep(200);
    const items = await wb.evaluate(() =>
      [...document.querySelectorAll('.context-view .monaco-menu .action-label, .monaco-menu-container .action-label')]
        .map((e) => e.textContent.trim()).filter(Boolean));
    console.log('branch menu items:', JSON.stringify(items));
    await shot('native-04-branch-context-menu.png');
    await wb.keyboard.press('Escape');
  });

  await browser.close().catch(() => {});
  console.log('DONE');
})().catch((e) => { console.error('DRIVE ERROR:', e); process.exit(1); });
