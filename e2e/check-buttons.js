// Functional check of the toolbar buttons (Refresh, Fetch, Pull, Push,
// New Branch, Compare) against REAL VS Code + real git, driven over CDP.
// Run via:  DRIVE_JS=e2e/check-buttons.js e2e/run-shots.sh
//
// Each check asserts on observable state (tracking counts in #rightHeader,
// tree nodes, the compare overlay, native input boxes) rather than just
// "the click didn't throw". Exits non-zero if any button fails.
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const path = require('path');

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const DEMO = process.env.DEMO_DIR; // synthetic repo; its origin/clone siblings live next to it
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
}

// ---- webview state probes ---------------------------------------------------
// Tracking counts as the RightHeader renders them: "Incoming (N)" / "(N Outgoing)".
const readState = (frame) => frame.evaluate(() => {
  const hdr = document.getElementById('rightHeader')?.textContent || '';
  const inc = hdr.match(/Incoming \((\d+)\)/);
  const out = hdr.match(/\((\d+) Outgoing\)/);
  const err = document.querySelector('#rows .empty');
  return {
    incoming: inc ? Number(inc[1]) : null,
    outgoing: out ? Number(out[1]) : null,
    rows: document.querySelectorAll('#rows .commit-row').length,
    branches: [...document.querySelectorAll('#tree .tree-node:not(.group) .label')].map((n) => n.textContent),
    header: hdr,
    error: err ? err.textContent : null,
  };
});
async function waitState(frame, pred, label, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await readState(frame);
    if (pred(last)) return last;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}; last state: ${JSON.stringify(last)}`);
}
const clickToolbar = (frame, reSource) => frame.evaluate((src) => {
  const rx = new RegExp(src);
  const b = [...document.querySelectorAll('#toolbar button')].find((x) => rx.test(x.textContent));
  if (b) { b.click(); return b.textContent.trim(); }
  return null;
}, reSource);

(async () => {
  if (!DEMO) throw new Error('DEMO_DIR not set');
  const ROOT = path.dirname(DEMO);
  const CLONE = path.join(ROOT, 'teammate-clone');

  const browser = await chromium.connectOverCDP(CDP);
  const wb = await findWorkbench(browser);
  console.log('workbench:', wb.url());
  try { await wb.bringToFront(); } catch {}
  await wb.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await sleep(3000);
  await dismissOnboarding(wb);
  await sleep(800);
  try { await runCommand(wb, 'View: Close All Editors'); } catch (e) { console.log('close-welcome:', e.message); }
  await sleep(800);
  await runCommand(wb, 'Open Branch View');
  await sleep(2500);

  const { frame } = await findFrameWith(browser, '#tree');
  await frame.waitForSelector('#tree .tree-node', { timeout: 25000 });
  await frame.waitForSelector('#rows .commit-row', { timeout: 25000 });
  await sleep(1500);

  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`PASS ${name}`);
    } catch (e) {
      results.push({ name, ok: false, err: e.message });
      console.error(`FAIL ${name}: ${e.message}`);
    }
  };

  const initial = await readState(frame);
  console.log('initial state:', JSON.stringify(initial));
  // make-repo.sh leaves main ahead 2 / behind 1 of origin/main.
  if (initial.incoming !== 1 || initial.outgoing !== 2) {
    console.log('WARNING: unexpected initial tracking counts (expected incoming 1 / outgoing 2)');
  }

  // ---- Refresh ---------------------------------------------------------------
  await check('Refresh', async () => {
    // Focus another branch first so Refresh has something to reset.
    await frame.evaluate(() => {
      const n = [...document.querySelectorAll('#tree .tree-node:not(.group)')].find((e) => (e.querySelector('.label') || {}).textContent === 'feature/payments');
      if (n) n.click();
    });
    await sleep(1500);
    const clicked = await clickToolbar(frame, '^⟳?\\s*Refresh');
    if (!clicked) throw new Error('Refresh button not found');
    // Refresh resets focus to the current branch (main) and reloads data.
    await waitState(frame, (s) => s.rows > 0 && !s.error && /Branch: main/.test(s.header), 'refresh back to main');
  });

  // ---- Fetch -----------------------------------------------------------------
  await check('Fetch', async () => {
    // Teammate pushes a second commit to origin/main → after Fetch, Incoming
    // must go 1 → 2. This proves the button actually ran `git fetch`.
    execSync('git pull -q && echo fetched >> HOTFIX.md && git add -A && git -c user.name=Grace -c user.email=grace@example.com commit -q -m "Second hotfix" && git push -q origin main', { cwd: CLONE, shell: '/bin/bash' });
    const clicked = await clickToolbar(frame, 'Fetch');
    if (!clicked) throw new Error('Fetch button not found');
    await waitState(frame, (s) => s.incoming === 2 && !s.error, 'incoming to become 2 after fetch');
  });

  // ---- Pull ------------------------------------------------------------------
  await check('Pull', async () => {
    const clicked = await clickToolbar(frame, '^⤓?\\s*Pull$');
    if (!clicked) throw new Error('Pull button not found');
    // Diverged (ahead 2 / behind 2) + merge strategy → merge commit; behind → 0.
    await waitState(frame, (s) => s.incoming === 0 && !s.error, 'incoming to become 0 after pull', 30000);
  });

  // ---- Push ------------------------------------------------------------------
  await check('Push', async () => {
    const clicked = await clickToolbar(frame, 'Push');
    if (!clicked) throw new Error('Push button not found');
    await waitState(frame, (s) => s.outgoing === 0 && !s.error, 'outgoing to become 0 after push', 30000);
    // Confirm on disk: origin/main == main
    const same = execSync('test "$(git rev-parse main)" = "$(git rev-parse origin/main)" && echo yes || echo no', { cwd: DEMO, shell: '/bin/bash' }).toString().trim();
    if (same !== 'yes') throw new Error('origin/main does not match main after push');
  });

  // ---- New Branch ------------------------------------------------------------
  await check('New Branch', async () => {
    const clicked = await clickToolbar(frame, 'New Branch');
    if (!clicked) throw new Error('New Branch button not found');
    let visible = false;
    for (let i = 0; i < 25 && !visible; i++) { await sleep(400); visible = await paletteVisible(wb); }
    if (!visible) throw new Error('input box did not appear');
    await wb.keyboard.type('qa/button-check', { delay: 30 });
    await sleep(400);
    await wb.keyboard.press('Enter');
    // createBranch is `checkout -b`, so the new branch becomes current+focused.
    await waitState(frame, (s) => s.branches.includes('qa/button-check') && /Branch: qa\/button-check/.test(s.header), 'new branch in tree and focused');
    const cur = execSync('git branch --show-current', { cwd: DEMO }).toString().trim();
    if (cur !== 'qa/button-check') throw new Error(`HEAD is on "${cur}", expected qa/button-check`);
  });

  // ---- Compare ---------------------------------------------------------------
  await check('Compare', async () => {
    const clicked = await clickToolbar(frame, 'Compare');
    if (!clicked) throw new Error('Compare button not found');
    await sleep(500);
    const armed = await frame.evaluate(() => [...document.querySelectorAll('#toolbar button')].some((b) => /Comparing:/.test(b.textContent)));
    if (!armed) throw new Error('Compare did not arm (no "Comparing:" label)');
    await frame.evaluate(() => {
      const n = [...document.querySelectorAll('#tree .tree-node:not(.group)')].find((e) => (e.querySelector('.label') || {}).textContent === 'feature/payments');
      if (n) n.click();
    });
    await frame.waitForSelector('#overlay .panel', { timeout: 20000 });
    const overlay = await frame.evaluate(() => document.querySelector('#overlay .panel')?.textContent.slice(0, 200));
    console.log('compare overlay:', overlay);
    await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  });

  await browser.close().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log('\n==== BUTTON CHECK SUMMARY ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.err ? ' — ' + r.err : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('CHECK ERROR:', e); process.exit(1); });
