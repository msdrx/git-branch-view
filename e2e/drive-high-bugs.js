// Focused e2e coverage for the high-severity fixes in bugs.md:
// - branch operations use full ref identities when local/remote short names collide
// - stale async host responses do not overwrite newer webview state
// - literal paths containing the rename arrow text open as their real path
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const DEMO = process.env.DEMO_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: DEMO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function allPages(browser) {
  const out = [];
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) out.push(p);
  return out;
}

async function findWorkbench(browser, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const p of allPages(browser)) {
      let url = '';
      try { url = p.url(); } catch {}
      if (url.includes('workbench')) {
        try { if (await p.$('.monaco-workbench')) return p; } catch {}
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
        try { if (await f.$(selector)) return { page: p, frame: f }; } catch {}
      }
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
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await wb.bringToFront(); } catch {}
    await wb.mouse.click(800, 500);
    await sleep(300);
    await wb.keyboard.press('Control+Shift+P');
    await sleep(900);
    if (!(await paletteVisible(wb))) {
      await wb.keyboard.press('F1');
      await sleep(900);
    }
    if (await paletteVisible(wb)) {
      await wb.keyboard.type(text, { delay: 20 });
      await sleep(800);
      await wb.keyboard.press('Enter');
      await sleep(1800);
      return;
    }
  }
  throw new Error('command palette did not open');
}

async function dismissOnboarding(wb) {
  const present = () => wb.evaluate(() =>
    !!document.querySelector('[class*="onboarding-a-"], .gettingStartedContainer')
  ).catch(() => false);
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
    await wb.keyboard.press('Escape');
    await sleep(700);
  }
}

function prepareDemoRepo() {
  assert(DEMO, 'DEMO_DIR is required');
  git(['config', 'user.name', 'E2E Local']);
  git(['config', 'user.email', 'e2e@example.com']);
  git(['checkout', '-q', 'main']);

  // A local branch whose short name collides with the remote-tracking branch
  // origin/main. Old b.name-based selection could not distinguish these.
  git(['branch', '-f', 'origin/main', 'main']);
  git(['checkout', '-q', 'origin/main']);
  execFileSync('sh', ['-c', 'printf "local collision\\n" > LOCAL_COLLISION.md'], { cwd: DEMO });
  git(['add', 'LOCAL_COLLISION.md']);
  git(['commit', '-q', '-m', 'Local branch named like remote']);

  git(['checkout', '-q', 'main']);
  execFileSync('mkdir', ['-p', 'docs'], { cwd: DEMO });
  execFileSync('sh', ['-c', 'printf "arrow path\\n" > "docs/path → marker.txt"'], { cwd: DEMO });
  git(['add', 'docs/path → marker.txt']);
  git(['commit', '-q', '-m', 'Add arrow separator path']);

  return {
    arrowHash: git(['rev-parse', 'HEAD']),
    mainHead: git(['rev-parse', 'refs/heads/main']),
    collisionHead: git(['rev-parse', 'refs/heads/origin/main']),
    remoteHead: git(['rev-parse', 'refs/remotes/origin/main']),
  };
}

async function clickBranch(frame, opts) {
  const ok = await frame.evaluate(({ label, group }) => {
    let currentGroup = '';
    for (const n of document.querySelectorAll('#tree .tree-node')) {
      if (n.classList.contains('group')) {
        currentGroup = (n.querySelector('.label') || {}).textContent || '';
        continue;
      }
      const text = (n.querySelector('.label') || {}).textContent || '';
      if (text === label && (!group || currentGroup === group)) {
        n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
    }
    return false;
  }, opts);
  assert(ok, `branch not found: ${JSON.stringify(opts)}`);
}

async function rowTexts(frame) {
  return frame.evaluate(() =>
    [...document.querySelectorAll('#rows .commit-row')].map((r) => r.textContent || '')
  );
}

async function waitRowsContain(frame, text, timeout = 20000) {
  await frame.waitForFunction((needle) =>
    [...document.querySelectorAll('#rows .commit-row')].some((r) => (r.textContent || '').includes(needle)),
    text,
    { timeout }
  );
}

async function dispatchHost(frame, msg) {
  await frame.evaluate((m) => {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
  }, msg);
}

(async () => {
  const refs = prepareDemoRepo();
  console.log('prepared external demo:', DEMO, JSON.stringify(refs));

  const browser = await chromium.connectOverCDP(CDP);
  const wb = await findWorkbench(browser);
  try { await wb.bringToFront(); } catch {}
  await wb.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await sleep(2500);
  await dismissOnboarding(wb);
  try { await runCommand(wb, 'View: Close All Editors'); } catch {}
  await runCommand(wb, 'Git Branches: Open Branch View');

  const { frame } = await findFrameWith(browser, '#tree');
  await frame.waitForSelector('#tree .tree-node:not(.group)', { timeout: 25000 });
  await frame.waitForSelector('#rows .commit-row', { timeout: 25000 });

  // Full ref identity: local refs/heads/origin/main and remote
  // refs/remotes/origin/main have the same short name, but selecting each row
  // must show its own history.
  await clickBranch(frame, { label: 'origin/main', group: 'Branches' });
  await waitRowsContain(frame, 'Local branch named like remote');
  let rows = await rowTexts(frame);
  assert(rows.some((r) => r.includes('Local branch named like remote')), 'local collision branch history not shown');
  assert(!rows.some((r) => r.includes('Hotfix: patch security advisory')), 'remote hotfix leaked into local collision branch');
  console.log('OK local collision branch selected by full ref');

  await clickBranch(frame, { label: 'main', group: 'remotes/origin' });
  await waitRowsContain(frame, 'Hotfix: patch security advisory');
  rows = await rowTexts(frame);
  assert(rows.some((r) => r.includes('Hotfix: patch security advisory')), 'remote origin/main history not shown');
  assert(!rows.some((r) => r.includes('Local branch named like remote')), 'local collision commit leaked into remote branch');
  console.log('OK remote branch selected by full ref');

  // Stale branchCommits should not overwrite the currently selected remote ref.
  await dispatchHost(frame, {
    type: 'branchCommits',
    ref: 'refs/heads/origin/main',
    commits: [{
      hash: refs.collisionHead,
      shortHash: refs.collisionHead.slice(0, 8),
      parents: [],
      authorName: 'Stale',
      authorEmail: 'stale@example.com',
      authorDate: '2026-01-01T00:00:00+00:00',
      subject: 'STALE branch response should not render',
      refs: [],
    }],
    hasMore: false,
  });
  await sleep(500);
  rows = await rowTexts(frame);
  assert(!rows.some((r) => r.includes('STALE branch response')), 'stale branchCommits overwrote current history');
  console.log('OK stale branchCommits ignored');

  // Stale commitDetail should not replace the detail for a newer selection.
  await clickBranch(frame, { label: 'main', group: 'Branches' });
  await waitRowsContain(frame, 'Add arrow separator path');
  const clickedTwo = await frame.evaluate(() => {
    const rows = [...document.querySelectorAll('#rows .commit-row')];
    const first = rows.find((r) => /Add arrow separator path/.test(r.textContent || ''));
    const second = rows.find((r) => /Tune metrics sampling/.test(r.textContent || ''));
    if (!first || !second) return false;
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });
  assert(clickedTwo, 'could not click two commits for stale detail test');
  await dispatchHost(frame, {
    type: 'commitDetail',
    detail: {
      commit: {
        hash: refs.arrowHash,
        shortHash: refs.arrowHash.slice(0, 8),
        parents: [],
        authorName: 'Stale',
        authorEmail: 'stale@example.com',
        authorDate: '2026-01-01T00:00:00+00:00',
        subject: 'STALE detail should not render',
        refs: [],
      },
      body: '',
      files: [{ status: 'M', path: 'STALE_DETAIL_SHOULD_NOT_RENDER.txt' }],
    },
  });
  await sleep(500);
  const staleFileVisible = await frame.evaluate(() =>
    (document.querySelector('#changes')?.textContent || '').includes('STALE_DETAIL_SHOULD_NOT_RENDER')
  );
  assert(!staleFileVisible, 'stale commitDetail rendered in changes pane');
  console.log('OK stale commitDetail ignored');

  // Literal arrow separator in a path: it should not be split like a rename.
  await frame.evaluate(() => {
    const row = [...document.querySelectorAll('#rows .commit-row')]
      .find((r) => /Add arrow separator path/.test(r.textContent || ''));
    if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await frame.waitForSelector('#changes .file-node', { timeout: 20000 });
  await frame.evaluate(() => {
    const file = [...document.querySelectorAll('#changes .file-node')]
      .find((n) => /path → marker\.txt/.test(n.textContent || ''));
    if (!file) throw new Error('arrow path file node not found');
    file.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await wb.waitForFunction(() =>
    [...document.querySelectorAll('.tabs-container .tab')]
      .some((t) => /path\s*→\s*marker\.txt/.test(t.textContent || '')),
    null,
    { timeout: 15000 }
  );
  const tabs = await wb.evaluate(() =>
    [...document.querySelectorAll('.tabs-container .tab')].map((t) => t.textContent.trim())
  );
  assert(tabs.some((t) => /path\s*→\s*marker\.txt/.test(t)), 'arrow path diff tab did not use the full path');
  assert(!tabs.some((t) => /^marker\.txt\b/.test(t)), 'arrow path was split into marker.txt');
  console.log('OK literal arrow path opened without rename-split ambiguity');

  await browser.close().catch(() => {});
  console.log('DONE high bug e2e checks');
})().catch((e) => {
  console.error('HIGH BUG E2E ERROR:', e);
  process.exit(1);
});
