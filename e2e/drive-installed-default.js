const { chromium } = require('playwright-core');

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9225';
const SHOTS = process.env.SHOTS_DIR || `${__dirname}/shots`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function allPages(browser) {
  const out = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      out.push(p);
    }
  }
  return out;
}

async function findWorkbench(browser, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const p of allPages(browser)) {
      let url = '';
      try {
        url = p.url();
      } catch {}
      if (url.includes('workbench')) {
        try {
          if (await p.$('.monaco-workbench')) {
            return p;
          }
        } catch {}
      }
    }
    await sleep(500);
  }
  throw new Error('workbench page not found');
}

async function findFrameWith(browser, selector, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const p of allPages(browser)) {
      for (const f of p.frames()) {
        try {
          if (await f.$(selector)) {
            return { page: p, frame: f };
          }
        } catch {}
      }
    }
    await sleep(500);
  }
  throw new Error('frame containing ' + selector + ' not found');
}

const paletteVisible = (wb) => wb.evaluate(() => {
  const w = document.querySelector('.quick-input-widget');
  if (!w) {
    return false;
  }
  const s = getComputedStyle(w);
  return s.display !== 'none' && s.visibility !== 'hidden' && w.getBoundingClientRect().height > 0;
});

async function runCommand(wb, text) {
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    try {
      await wb.bringToFront();
    } catch {}
    await wb.mouse.click(800, 500);
    await sleep(300);
    await wb.keyboard.press('Control+Shift+P');
    await sleep(900);
    opened = await paletteVisible(wb);
    if (!opened) {
      await wb.keyboard.press('F1');
      await sleep(900);
      opened = await paletteVisible(wb);
    }
  }
  if (!opened) {
    throw new Error('command palette did not open');
  }
  await wb.keyboard.type(text, { delay: 25 });
  await sleep(1000);
  await wb.keyboard.press('Enter');
  console.log('ran command:', text);
}

async function dismissOnboarding(wb) {
  const present = () => wb.evaluate(() => !!document.querySelector('[class*="onboarding-a-"], .gettingStartedContainer')).catch(() => false);
  for (let i = 0; i < 12 && !(await present()); i++) {
    await sleep(500);
  }
  for (let i = 0; i < 12 && (await present()); i++) {
    try {
      const close = wb.locator('[class*="onboarding-a-"] .codicon-close, .codicon-dialog-close, [aria-label="Close Dialog"]');
      if (await close.count()) {
        await close.first().click({ timeout: 2000 });
        await sleep(900);
        continue;
      }
    } catch {}
    try {
      const skip = wb.locator('text=Continue without Signing In');
      if (await skip.count()) {
        await skip.first().click({ timeout: 2000 });
        await sleep(900);
        continue;
      }
    } catch {}
    await wb.keyboard.press('Escape');
    await sleep(700);
  }
}

const quickPickItems = (wb) => wb.evaluate(() => {
  const w = document.querySelector('.quick-input-widget');
  if (!w || getComputedStyle(w).display === 'none') {
    return null;
  }
  return [...w.querySelectorAll('.monaco-list-row')].map((r) => ({
    label: ((r.querySelector('.label-name') || {}).textContent || '').trim(),
    description: ((r.querySelector('.label-description') || {}).textContent || '').trim(),
    text: r.textContent.trim(),
  }));
});

const nativePaneState = (wb) => wb.evaluate(() => {
  const panes = [...document.querySelectorAll('.pane')].map((p) => ({
    title: ((p.querySelector('.pane-header .title') || {}).textContent || '').trim(),
    rows: [...p.querySelectorAll('.monaco-list-row')].map((r) => r.textContent.trim()),
  }));
  return panes.filter((p) => /^(Branches|Commits)$/i.test(p.title));
});

(async () => {
  let failures = 0;
  const fail = (msg) => {
    failures++;
    console.error('FAIL:', msg);
  };

  const browser = await chromium.connectOverCDP(CDP);
  const wb = await findWorkbench(browser);
  console.log('workbench:', wb.url());
  try {
    await wb.bringToFront();
  } catch {}
  await wb.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await sleep(3000);
  await dismissOnboarding(wb);
  await sleep(800);

  try {
    await runCommand(wb, 'View: Close All Editors');
  } catch (e) {
    console.log('close editors:', e.message);
  }
  await sleep(800);

  await runCommand(wb, 'Git Branches: Select UI Mode');
  let items = null;
  for (let i = 0; i < 20 && !(items && items.length); i++) {
    items = await quickPickItems(wb);
    await sleep(400);
  }
  console.log('quick pick items:', JSON.stringify(items));
  const labels = (items || []).map((i) => i.label);
  for (const want of ['Webview', 'Native', 'Both']) {
    if (!labels.includes(want)) {
      fail(`Select UI Mode QuickPick is missing "${want}"`);
    }
  }
  const current = (items || []).find((i) => /current/.test(i.description) || /current/.test(i.text));
  if (!current) {
    fail('no UI mode is marked current');
  } else if (current.label !== 'Webview') {
    fail(`expected Webview as the default current mode, got ${current.label}`);
  }
  await wb.keyboard.press('Escape');
  await sleep(500);

  await runCommand(wb, 'Git Branches: Open Branch View');
  const { frame } = await findFrameWith(browser, '#tree');
  await frame.waitForSelector('#tree .tree-node', { timeout: 25000 });
  await frame.waitForSelector('#rows .commit-row', { timeout: 25000 });
  const rendered = await frame.evaluate(() => ({
    branches: document.querySelectorAll('#tree .tree-node:not(.group)').length,
    commits: document.querySelectorAll('#rows .commit-row').length,
  }));
  console.log('webview rendered:', JSON.stringify(rendered));
  if (!rendered.branches || !rendered.commits) {
    fail('webview did not render branch and commit data');
  }

  const clickedNativeContainer = await wb.evaluate(() => {
    const els = [...document.querySelectorAll('.activitybar .action-item, .activitybar [aria-label], .activitybar [title]')];
    const hit = els.find((e) =>
      /Git Branches/i.test(e.getAttribute('aria-label') || e.getAttribute('title') || ''));
    if (!hit) {
      return false;
    }
    const item = hit.closest('.action-item') || hit;
    (item.querySelector('a, .action-label') || item).click();
    return true;
  });
  console.log('clicked native activity-bar container:', clickedNativeContainer);
  await sleep(1500);
  const panes = await nativePaneState(wb);
  console.log('native panes visible:', JSON.stringify(panes));
  if (panes.some((p) => p.rows.length)) {
    fail('native Branches/Commits panes are active on first install');
  }

  await wb.screenshot({ path: `${SHOTS}/installed-default-webview.png` }).catch(() => {});
  await browser.close().catch(() => {});
  if (failures) {
    console.error(`DONE with ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('DONE: installed VSIX defaults to Webview while webview is functional');
})().catch((e) => {
  console.error('DRIVE ERROR:', e);
  process.exit(1);
});
