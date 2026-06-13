// Drives real VS Code (over CDP) to open the Branch View webview and
// capture a suite of screenshots. Interactions are dispatched on the real DOM
// handlers, so the extension host genuinely runs git for compare/detail and
// shows native VS Code input boxes for write commands.
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
    if (!opened && attempt === 0) {
      console.log('focus state:', JSON.stringify(await wb.evaluate(() => ({ hasFocus: document.hasFocus(), active: document.activeElement && document.activeElement.className }))));
    }
  }
  if (!opened) {
    try { await wb.screenshot({ path: `${process.env.SHOTS_DIR || '.'}/debug-nopalette.png` }); } catch {}
    throw new Error('command palette did not open');
  }
  await wb.keyboard.type(text, { delay: 25 });
  await sleep(1000);
  await wb.keyboard.press('Enter');
  console.log('ran command:', text);
}

// Right-click a branch by name and wait for its context menu to open.
async function openBranchMenu(frame, name) {
  const ok = await frame.evaluate((nm) => {
    const n = [...document.querySelectorAll('#tree .tree-node:not(.group)')].find((e) => (e.querySelector('.label') || {}).textContent === nm);
    if (!n) return false;
    const r = n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.bottom - 4) }));
    return true;
  }, name);
  if (ok) await frame.waitForFunction(() => { const m = document.getElementById('contextMenu'); return m && !m.classList.contains('hidden') && m.querySelector('.item'); }, { timeout: 8000 });
  return ok;
}
// Click a context-menu item whose text matches a regex source string.
async function clickMenuItem(frame, reSource) {
  return frame.evaluate((src) => {
    const rx = new RegExp(src);
    const it = [...document.querySelectorAll('#contextMenu .item')].find((e) => rx.test(e.textContent));
    if (it) { it.click(); return it.textContent.trim(); }
    return null;
  }, reSource);
}
// On a fresh profile VS Code shows a "Sign in to use GitHub Copilot" onboarding
// dialog that grabs focus and blocks the command palette. Dismiss it (no-op on
// reused profiles).
async function dismissOnboarding(wb) {
  const present = () => wb.evaluate(() => !!document.querySelector('[class*="onboarding-a-"], .gettingStartedContainer')).catch(() => false);
  // give the dialog a moment to appear on a fresh profile
  for (let i = 0; i < 12 && !(await present()); i++) await sleep(500);

  let acted = false;
  for (let i = 0; i < 12 && (await present()); i++) {
    // 1) the dialog's close (X) button kills the whole multi-step flow at once
    try {
      const x = wb.locator('[class*="onboarding-a-"] .codicon-close, .codicon-dialog-close, [aria-label="Close Dialog"]');
      if (await x.count()) { await x.first().click({ timeout: 2000 }); acted = true; await sleep(900); continue; }
    } catch {}
    // 2) the per-step skip link
    try {
      const skip = wb.locator('text=Continue without Signing In');
      if (await skip.count()) { await skip.first().click({ timeout: 2000 }); acted = true; await sleep(900); continue; }
    } catch {}
    // 3) fallback: Escape
    await wb.keyboard.press('Escape'); acted = true; await sleep(700);
  }
  console.log((await present()) ? 'WARNING: onboarding still present' : (acted ? 'onboarding dismissed' : 'no onboarding dialog detected'));
  return acted;
}
// Wait for a native VS Code modal dialog (e.g. the delete confirmation).
async function waitDialog(wb, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await wb.evaluate(() => !!document.querySelector('.monaco-dialog-modal-block, .dialog-box, .monaco-dialog-box'))) return true;
    await sleep(300);
  }
  return false;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const wb = await findWorkbench(browser);
  console.log('workbench:', wb.url());
  try { await wb.bringToFront(); } catch {}
  await wb.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await sleep(3000);

  // Dismiss the first-run "Sign in to use GitHub Copilot" onboarding dialog.
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
  console.log('aux bar width:', await auxBarWidth());

  // Close the first-run Welcome / Getting Started editor (Escape can't close an
  // editor tab, so dismissOnboarding leaves it open and focused).
  try { await runCommand(wb, 'View: Close All Editors'); } catch (e) { console.log('close-welcome:', e.message); }
  await sleep(800);

  // Probe: open palette, type our command, dump the matched list before Enter.
  await wb.mouse.click(800, 500); await sleep(300);
  await wb.keyboard.press('Control+Shift+P'); await sleep(900);
  console.log('palette visible:', await paletteVisible(wb));
  await wb.keyboard.type('Open Branch View', { delay: 30 }); await sleep(900);
  const items = await wb.evaluate(() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((r) => r.textContent.trim()).slice(0, 6));
  console.log('DBG palette items:', JSON.stringify(items));
  await wb.keyboard.press('Enter'); await sleep(2500);
  const dbg = await wb.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim()),
    iframes: [...document.querySelectorAll('iframe')].length,
    notif: [...document.querySelectorAll('.notification-toast, .notifications-toasts')].map((n) => n.textContent.slice(0, 140)),
  }));
  console.log('DBG after open:', JSON.stringify(dbg));

  let { frame } = await findFrameWith(browser, '#tree');
  await frame.waitForSelector('#tree .tree-node', { timeout: 25000 });
  await frame.waitForSelector('#rows .commit-row', { timeout: 25000 });
  await sleep(1500);
  console.log('rendered:', JSON.stringify(await frame.evaluate(() => ({
    branches: document.querySelectorAll('#tree .tree-node:not(.group)').length,
    commits: document.querySelectorAll('#rows .commit-row').length,
  }))));

  // React owns the overlay/menu DOM, so never remove nodes from outside —
  // dispatch Escape instead (the app closes both on it) and let React unmount.
  const clearOverlays = () => frame.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  const shot = async (name) => { await wb.screenshot({ path: `${SHOTS}/${name}` }); console.log('saved', name); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.error('STEP FAILED', name, e.message); } };

  // 01 — main layout ----------------------------------------------------------
  await step('01', () => shot('01-main-layout.png'));

  // 01b — TEMP: verify column resize drag changes the shared grid template -----
  await step('01b', async () => {
    const before = await frame.evaluate(() => ({
      grid: getComputedStyle(document.getElementById('columns')).gridTemplateColumns,
      date: getComputedStyle(document.documentElement).getPropertyValue('--col-date').trim(),
      resizers: document.querySelectorAll('#columns .col-resizer').length,
    }));
    // Drag the Date column's right-edge divider 90px to the right.
    await frame.evaluate(() => {
      const cols = [...document.querySelectorAll('#columns .col')];
      const date = cols[3];
      const rz = date.querySelector('.col-resizer');
      const r = rz.getBoundingClientRect();
      const x = r.left + 2, y = r.top + 5;
      rz.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 90, clientY: y }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 90, clientY: y }));
    });
    await sleep(500);
    const after = await frame.evaluate(() => ({
      grid: getComputedStyle(document.getElementById('columns')).gridTemplateColumns,
      date: getComputedStyle(document.documentElement).getPropertyValue('--col-date').trim(),
      rowGrid: getComputedStyle(document.querySelector('#rows .commit-row')).gridTemplateColumns,
    }));
    console.log('RESIZE before:', JSON.stringify(before));
    console.log('RESIZE after :', JSON.stringify(after));
    console.log('RESIZE header==row grid:', after.grid === after.rowGrid);
    await shot('01b-resized-date-column.png');
  });

  // 02 — compare branches (main ⇄ feature/payments): the ahead/behind commits
  // replace the right list and the changed files land in the left Changes pane
  await step('02', async () => {
    await frame.evaluate(() => { const b = [...document.querySelectorAll('#toolbar button')].find((x) => /Compare/.test(x.textContent)); if (b) b.click(); });
    await sleep(400);
    await frame.evaluate(() => { const n = [...document.querySelectorAll('#tree .tree-node:not(.group)')].find((e) => (e.querySelector('.label') || {}).textContent === 'feature/payments'); if (n) n.click(); });
    await frame.waitForSelector('#rows .compare-section', { timeout: 20000 });
    await frame.waitForSelector('#changes .file-node', { timeout: 20000 });
    await sleep(1000);
    console.log('compare:', JSON.stringify(await frame.evaluate(() => ({
      sections: [...document.querySelectorAll('#rows .compare-section')].map((s) => s.textContent),
      commits: document.querySelectorAll('#rows .commit-row').length,
      header: document.querySelector('#changes .changes-header')?.textContent,
      files: [...document.querySelectorAll('#changes .file-node .label')].map((n) => n.textContent),
    }))));
    await shot('02-compare-branches.png');
  });
  await clearOverlays(); await sleep(400); // Escape ends the comparison

  // 03 — click a commit: its changed files appear as a tree in the left pane,
  // below the branch tree ----------------------------------------------------
  await step('03', async () => {
    await frame.evaluate(() => {
      const r = [...document.querySelectorAll('#rows .commit-row')].find((e) => /Refactor engine core/.test(e.textContent));
      if (r) r.click();
    });
    await frame.waitForSelector('#changes .file-node', { timeout: 20000 });
    await sleep(1000);
    console.log('changes pane:', JSON.stringify(await frame.evaluate(() => ({
      header: document.querySelector('#changes .changes-header')?.textContent,
      files: [...document.querySelectorAll('#changes .file-node .label')].map((n) => n.textContent),
    }))));
    // Verify the pane resizes from its top divider (drag up 120px).
    console.log('changes resize:', JSON.stringify(await frame.evaluate(() => {
      const pane = document.getElementById('changes');
      const before = Math.round(pane.getBoundingClientRect().height);
      const dv = document.getElementById('hdivider');
      const r = dv.getBoundingClientRect();
      const x = r.left + 60, y = r.top + 2;
      dv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y - 120 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y - 120 }));
      const after = Math.round(pane.getBoundingClientRect().height);
      return { before, after, grew: after > before };
    })));
    await sleep(400);
    await shot('03-commit-details.png');
  });

  // 03b — click a changed file: VS Code's REAL diff editor opens in a split
  // beside the panel; the Branch View (and its commit list) stays visible ----
  await step('03b', async () => {
    await frame.evaluate(() => {
      const f = [...document.querySelectorAll('#changes .file-node')].find((e) => /engine\.js/.test(e.textContent));
      if (f) f.click();
    });
    // The diff editor appears as a tab in a second editor group.
    await wb.waitForFunction(() => [...document.querySelectorAll('.tabs-container .tab')]
      .some((t) => /engine\.js/.test(t.textContent)), { timeout: 20000 });
    await sleep(1500);
    console.log('split diff:', JSON.stringify(await wb.evaluate(() => ({
      groups: document.querySelectorAll('.editor-group-container').length,
      tabs: [...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim()),
      diffEditors: document.querySelectorAll('.monaco-diff-editor').length,
    }))));
    console.log('panel still live:', JSON.stringify(await frame.evaluate(() => ({
      commitRows: document.querySelectorAll('#rows .commit-row').length,
      selectedFile: document.querySelector('#changes .file-node.selected .label')?.textContent,
    }))));
    await shot('03b-file-diff.png');
    // Close the diff via its tab's ✕ (it sits in the non-focused group, so
    // "View: Close Editor" would hit the Branch View instead), then close the
    // changes pane for the remaining steps.
    await wb.evaluate(() => {
      const tab = [...document.querySelectorAll('.tabs-container .tab')].find((t) => /engine\.js/.test(t.textContent));
      const close = tab && tab.querySelector('.tab-actions .codicon-close, .action-label.codicon-close');
      if (close) close.click();
    });
    await sleep(1200);
    await frame.evaluate(() => { const b = document.querySelector('#changes .close-btn'); if (b) b.click(); });
  });
  await clearOverlays(); await sleep(400);

  // 03c — arrow-key navigation: Up/Down moves the commit selection (loading
  // each commit's files); once a changed file is selected the same keys walk
  // the changed-files tree instead, leaving the commit selection alone -------
  await step('03c', async () => {
    const pressArrow = (key) => frame.evaluate((k) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    }, key);
    const navState = () => frame.evaluate(() => ({
      commit: document.querySelector('#rows .commit-row.selected .msg')?.textContent,
      header: document.querySelector('#changes .changes-header .label')?.textContent,
      file: document.querySelector('#changes .file-node.selected .label')?.textContent ?? null,
      files: [...document.querySelectorAll('#changes .file-node .label')].map((n) => n.textContent),
    }));
    // Poll with evaluate(): waitForFunction's rAF polling injects script via
    // eval, which the webview CSP and the workbench's Trusted Types both
    // forbid (it only succeeds when the condition is already true on the
    // first check).
    const waitIn = async (target, fn, arg, what, timeout = 20000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await target.evaluate(fn, arg)) return;
        await sleep(300);
      }
      throw new Error('timeout waiting for ' + what);
    };
    const waitInFrame = (fn, arg, what, timeout) => waitIn(frame, fn, arg, what, timeout);
    const changesHeaderHas = (reSource) => waitInFrame((src) => {
      const h = document.querySelector('#changes .changes-header');
      return !!h && new RegExp(src).test(h.textContent);
    }, reSource, 'changes header ~ ' + reSource);
    const selectedFileIs = (reSource) => waitInFrame((src) => {
      const f = document.querySelector('#changes .file-node.selected');
      return !!f && new RegExp(src).test(f.textContent);
    }, reSource, 'selected file ~ ' + reSource, 8000);

    // Commit navigation: select "Update user guide", ArrowUp moves to the
    // commit above ("Refactor engine core") and loads its files.
    await frame.evaluate(() => {
      const r = [...document.querySelectorAll('#rows .commit-row')].find((e) => /Update user guide/.test(e.textContent));
      if (r) r.click();
    });
    await changesHeaderHas('Update user guide');
    await pressArrow('ArrowUp');
    await changesHeaderHas('Refactor engine core');
    console.log('commit arrow nav:', JSON.stringify(await navState()));

    // File navigation: the initial commit has two files in different dirs
    // (.vscode/settings.json, README.md). Select the first, then ArrowDown
    // must move the FILE selection, not the commit selection.
    await frame.evaluate(() => {
      const r = [...document.querySelectorAll('#rows .commit-row')].find((e) => /Initial project scaffolding/.test(e.textContent));
      if (r) r.click();
    });
    await changesHeaderHas('Initial project scaffolding');
    await frame.evaluate(() => {
      const f = [...document.querySelectorAll('#changes .file-node')].find((e) => /settings\.json/.test(e.textContent));
      if (f) f.click();
    });
    await selectedFileIs('settings\\.json');
    await pressArrow('ArrowDown');
    await selectedFileIs('README\\.md');
    const afterDown = await navState();
    console.log('file arrow nav (down):', JSON.stringify(afterDown));
    if (!/Initial project scaffolding/.test(afterDown.commit || '')) {
      throw new Error('commit selection moved during file navigation: ' + afterDown.commit);
    }
    // The arrow step opens the next file's diff, reusing the preview tab.
    await waitIn(wb, () => [...document.querySelectorAll('.tabs-container .tab')]
      .some((t) => /README\.md/.test(t.textContent)), undefined, 'README.md diff tab');
    // ArrowUp walks back; ArrowUp again clamps at the first file.
    await pressArrow('ArrowUp');
    await selectedFileIs('settings\\.json');
    await pressArrow('ArrowUp');
    await sleep(400);
    const afterUp = await navState();
    console.log('file arrow nav (up):', JSON.stringify(afterUp));
    if (!/settings\.json/.test(afterUp.file || '')) {
      throw new Error('ArrowUp did not clamp at the first file: ' + afterUp.file);
    }
    await shot('03c-arrow-key-navigation.png');
    // Close the preview diff tab and the changes pane for the next steps.
    await wb.evaluate(() => {
      const tab = [...document.querySelectorAll('.tabs-container .tab')].find((t) => /settings\.json|README\.md/.test(t.textContent));
      const close = tab && tab.querySelector('.tab-actions .codicon-close, .action-label.codicon-close');
      if (close) close.click();
    });
    await sleep(1200);
    await frame.evaluate(() => { const b = document.querySelector('#changes .close-btn'); if (b) b.click(); });
  });
  await clearOverlays(); await sleep(400);

  // 04 — branch context menu (right-click feature/login) ----------------------
  await step('04', async () => {
    await frame.evaluate(() => {
      const n = [...document.querySelectorAll('#tree .tree-node:not(.group)')].find((e) => (e.querySelector('.label') || {}).textContent === 'feature/login');
      if (!n) return;
      const r = n.getBoundingClientRect();
      n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 40), clientY: Math.round(r.bottom - 4) }));
    });
    await frame.waitForFunction(() => { const m = document.getElementById('contextMenu'); return m && !m.classList.contains('hidden') && m.querySelector('.item'); }, { timeout: 8000 });
    await sleep(600);
    await shot('04-branch-context-menu.png');
  });
  await clearOverlays(); await sleep(400);

  // 05 — commit context menu (right-click a commit row) -----------------------
  await step('05', async () => {
    await frame.evaluate(() => {
      const rows = [...document.querySelectorAll('#rows .commit-row')];
      const r0 = rows.find((e) => /Add login form/.test(e.textContent)) || rows[0];
      if (!r0) return;
      const r = r0.getBoundingClientRect();
      r0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 140), clientY: Math.round(r.bottom - 4) }));
    });
    await frame.waitForFunction(() => { const m = document.getElementById('contextMenu'); return m && !m.classList.contains('hidden') && m.querySelector('.item'); }, { timeout: 8000 });
    await sleep(600);
    await shot('05-commit-context-menu.png');
  });
  await clearOverlays(); await sleep(400);

  // 06 — branch-filtered graph (click feature/login -> just its history) ------
  await step('06', async () => {
    await frame.evaluate(() => { const n = [...document.querySelectorAll('#tree .tree-node:not(.group)')].find((e) => (e.querySelector('.label') || {}).textContent === 'feature/login'); if (n) n.click(); });
    await sleep(1500);
    await shot('06-branch-filtered-graph.png');
  });

  // 07 — tree filter box in use ----------------------------------------------
  await step('07', async () => {
    await frame.evaluate(() => { const f = document.getElementById('branchFilter'); f.value = 'feature'; f.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(800);
    await shot('07-tree-filter.png');
    await frame.evaluate(() => { const f = document.getElementById('branchFilter'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); });
  });
  await sleep(400);

  // 08 — native "New Branch" input box (then cancel) --------------------------
  await step('08', async () => {
    await frame.evaluate(() => { const b = [...document.querySelectorAll('#toolbar button')].find((x) => /New Branch/.test(x.textContent)); if (b) b.click(); });
    for (let i = 0; i < 20 && !(await paletteVisible(wb)); i++) await sleep(300);
    if (!(await paletteVisible(wb))) throw new Error('input box did not appear');
    await sleep(800);
    await shot('08-new-branch-input.png');
    await wb.keyboard.press('Escape');
  });
  await clearOverlays(); await sleep(400);

  // 09 — native modal: Delete branch confirmation (then cancel) ---------------
  await step('09', async () => {
    await openBranchMenu(frame, 'feature/payments');
    console.log('clicked menu item:', await clickMenuItem(frame, 'Delete'));
    if (!(await waitDialog(wb))) throw new Error('delete dialog did not appear');
    await sleep(900);
    await shot('09-delete-branch-confirm.png');
    await wb.keyboard.press('Escape');           // cancel — nothing is deleted
  });
  await clearOverlays(); await sleep(500);

  // 11 — dark theme (extension follows VS Code theme variables; the base
  // profile uses the light theme). The theme is switched by rewriting the
  // user settings file directly — VS Code live-watches it — because the theme
  // quick pick is unreliable offline (its marketplace search can swallow the
  // query and leave the picker open).
  await step('11', async () => {
    const fs = require('fs');
    const settingsPath = process.env.USER_SETTINGS;
    if (!settingsPath) throw new Error('USER_SETTINGS not set');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings['workbench.colorTheme'] = 'Dark Modern';
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    await sleep(2500);                            // let the theme apply
    // reload the full --all graph (Refresh) so the layout is complete again
    await frame.evaluate(() => { const b = [...document.querySelectorAll('#toolbar button')].find((x) => /Refresh/.test(x.textContent)); if (b) b.click(); });
    await sleep(1800);
    await shot('11-dark-theme.png');
  });
  await sleep(400);

  // 12 — checkout a branch (real write op) + the resulting notification -------
  await step('12', async () => {
    await openBranchMenu(frame, 'feature/login');
    console.log('clicked menu item:', await clickMenuItem(frame, 'Checkout feature/login'));
    await sleep(2000);                            // checkout + reload + toast
    await shot('12-checkout-notification.png');
  });

  await browser.close().catch(() => {});
  console.log('DONE');
})().catch((e) => { console.error('DRIVE ERROR:', e); process.exit(1); });
