// Drives real VS Code (over CDP) to exercise the BOTH UI mode
// (gitBranchView.ui resolves to "both"): verifies the native tree views and
// the webview panel are active at the same time, then runs the
// "Git Branches: Select UI Mode…" command, asserts the QuickPick offers
// Webview / Native / Both (current marked), picks Native, and checks that the
// gitBranchView.ui setting is written and the reload prompt appears.
// Screenshots land in ./shots/both-*.png.
const fs = require('fs');
const { chromium } = require('playwright-core');

const SHOTS = process.env.SHOTS_DIR || `${__dirname}/shots`;
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const USER_SETTINGS = process.env.USER_SETTINGS || '';
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
async function findFrameWith(browser, selector, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const p of allPages(browser)) {
      for (const f of p.frames()) { try { if (await f.$(selector)) return { page: p, frame: f }; } catch {} }
    }
    await sleep(500);
  }
  throw new Error('frame containing ' + selector + ' not found');
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
// Visible quick-input rows: [{label, description, detail}].
const quickPickItems = (wb) => wb.evaluate(() => {
  const w = document.querySelector('.quick-input-widget');
  if (!w || getComputedStyle(w).display === 'none') return null;
  return [...w.querySelectorAll('.monaco-list-row')].map((r) => ({
    label: ((r.querySelector('.label-name') || {}).textContent || '').trim(),
    description: ((r.querySelector('.label-description') || {}).textContent || '').trim(),
    detail: ((r.querySelector('.quick-input-list-row-meta, .label-detail') || r) === r
      ? '' : (r.querySelector('.quick-input-list-row-meta, .label-detail').textContent || '').trim()),
    text: r.textContent.trim(),
  }));
});
// Center of the quick-pick row whose label matches, for a real mouse click.
const quickPickRowCenter = (wb, labelRe) => wb.evaluate((src) => {
  const rx = new RegExp(src);
  const w = document.querySelector('.quick-input-widget');
  if (!w) return null;
  const row = [...w.querySelectorAll('.monaco-list-row')].find((r) =>
    rx.test(((r.querySelector('.label-name') || r).textContent || '')));
  if (!row) return null;
  const b = row.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), text: row.textContent.trim() };
}, labelRe);
const notificationTexts = (wb) => wb.evaluate(() =>
  [...document.querySelectorAll('.notifications-toasts .notification-list-item, .notifications-list-container .notification-list-item')]
    .map((n) => n.textContent.trim()));

(async () => {
  let failures = 0;
  const fail = (msg) => { failures++; console.error('FAIL:', msg); };

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

  // --- 1. native half: the activity-bar container + tree views exist ---------
  // The aria-label may sit on the .action-item or on a descendant (varies by
  // VS Code build), so match any labelled element inside the activity bar.
  const clickedIcon = await wb.evaluate(() => {
    const els = [...document.querySelectorAll('.activitybar .action-item, .activitybar [aria-label], .activitybar [title]')];
    const hit = els.find((e) =>
      /Git Branches/i.test(e.getAttribute('aria-label') || e.getAttribute('title') || ''));
    if (!hit) return false;
    const item = hit.closest('.action-item') || hit;
    (item.querySelector('a, .action-label') || item).click();
    return true;
  });
  console.log('clicked Git Branches activity-bar icon:', clickedIcon);
  if (!clickedIcon) {
    // Fallback: contributed view containers get a "View: Show <name>" command.
    try { await runCommand(wb, 'View: Show Git Branches'); }
    catch (e) { fail('Git Branches container not reachable (icon missing, command failed: ' + e.message + ')'); }
  }
  await sleep(2000);

  let branches = { found: false, rows: [] };
  let commits = { found: false, rows: [] };
  for (let i = 0; i < 30; i++) {
    branches = await paneState(wb, 'Branches');
    commits = await paneState(wb, 'Commits');
    if (branches.found && commits.found && branches.rows.length && commits.rows.length) break;
    await sleep(500);
  }
  console.log('BRANCHES pane:', JSON.stringify(branches));
  console.log('COMMITS  pane:', JSON.stringify(commits.rows ? commits.rows.slice(0, 4) : commits));
  if (!branches.found || !branches.rows.length) fail('native Branches view missing or empty');
  if (!commits.found || !commits.rows.length) fail('native Commits view missing or empty');
  await shot('both-01-native-views.png');

  // --- 2. webview half: the open command targets the graph panel -------------
  await runCommand(wb, 'Git Branches: Open Branch View');
  await sleep(2500);
  try {
    const { frame } = await findFrameWith(browser, '#tree');
    await frame.waitForSelector('#tree .tree-node', { timeout: 25000 });
    await frame.waitForSelector('#rows .commit-row', { timeout: 25000 });
    const counts = await frame.evaluate(() => ({
      branches: document.querySelectorAll('#tree .tree-node:not(.group)').length,
      commits: document.querySelectorAll('#rows .commit-row').length,
    }));
    console.log('webview rendered:', JSON.stringify(counts));
    if (!counts.branches || !counts.commits) fail('webview rendered no data');
  } catch (e) {
    fail('webview panel did not open in both mode: ' + e.message);
  }
  await shot('both-02-webview-and-native.png');

  // --- 3. the Select UI Mode QuickPick ----------------------------------------
  await runCommand(wb, 'Git Branches: Select UI Mode');
  let items = null;
  for (let i = 0; i < 20 && !(items && items.length); i++) { items = await quickPickItems(wb); await sleep(400); }
  console.log('quick pick items:', JSON.stringify(items));
  const labels = (items || []).map((i) => i.label);
  for (const want of ['Webview', 'Native', 'Both']) {
    if (!labels.includes(want)) fail(`Select UI Mode QuickPick is missing the "${want}" option`);
  }
  const current = (items || []).find((i) => /current/.test(i.description) || /current/.test(i.text));
  if (!current) fail('no option is marked as current');
  else if (current.label !== 'Both') fail(`expected "Both" marked current, got "${current.label}"`);
  await shot('both-03-select-ui-quickpick.png');

  // --- 4. pick Native → setting written + reload prompt -----------------------
  const target = await quickPickRowCenter(wb, '^Native$');
  if (!target) {
    fail('could not locate the Native row to click');
  } else {
    console.log('clicking quick pick row:', target.text);
    await wb.mouse.click(target.x, target.y);
  }

  // The setting lands in the profile's settings.json (ConfigurationTarget.Global).
  let settingWritten = false;
  for (let i = 0; i < 25 && !settingWritten; i++) {
    await sleep(400);
    if (USER_SETTINGS && fs.existsSync(USER_SETTINGS)) {
      try {
        const s = JSON.parse(fs.readFileSync(USER_SETTINGS, 'utf8'));
        settingWritten = s['gitBranchView.ui'] === 'native';
      } catch {}
    }
  }
  console.log('gitBranchView.ui == "native" in settings.json:', settingWritten);
  if (USER_SETTINGS && !settingWritten) fail('picking Native did not write gitBranchView.ui = "native"');

  let toasts = [];
  for (let i = 0; i < 20; i++) {
    toasts = await notificationTexts(wb);
    if (toasts.some((t) => /reload the window/i.test(t))) break;
    await sleep(400);
  }
  console.log('notifications:', JSON.stringify(toasts));
  if (!toasts.some((t) => /reload the window/i.test(t))) fail('reload-window prompt did not appear after changing the UI mode');
  await shot('both-04-reload-prompt.png');

  await browser.close().catch(() => {});
  if (failures) { console.error(`DONE with ${failures} failure(s)`); process.exit(1); }
  console.log('DONE: both mode + Select UI Mode verified');
})().catch((e) => { console.error('DRIVE ERROR:', e); process.exit(1); });
