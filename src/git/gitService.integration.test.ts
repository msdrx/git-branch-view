/**
 * Integration tests: GitService against REAL git repositories built in temp
 * dirs. The unit tests in gitService.test.ts verify parsing against canned
 * output; these verify the canned output matches what git actually emits —
 * the place where edge cases (renames, merges, unicode paths, gone upstreams,
 * detached HEAD, empty repos) live in practice.
 *
 * Everything here matters for showing change information correctly in the
 * Changes pane and the diff editor, so assertions are exact, not fuzzy.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, sep } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from './gitService';

/**
 * Isolated git env: the user's global/system config must not leak into the
 * fixture setup (e.g. commit.gpgsign or init.defaultBranch would break it).
 * Note GitService itself runs with the ambient env — behaviours it depends on
 * (rename detection) are pinned repo-locally in makeRepo, since repo config
 * outranks global config.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

/** Monotonic timestamps so --author-date-order is fully deterministic. */
let tick = 0;
function nextStamp(): string {
  const n = tick++;
  const hh = String(1 + Math.floor(n / 3600)).padStart(2, '0');
  const mm = String(Math.floor(n / 60) % 60).padStart(2, '0');
  const ss = String(n % 60).padStart(2, '0');
  return `2026-01-01T${hh}:${mm}:${ss}Z`;
}

interface Repo {
  dir: string;
  service: GitService;
  /** Run git in the fixture repo (setup only — assertions go via GitService). */
  run(...args: string[]): string;
  /** Write a file, creating parent dirs. */
  write(rel: string, content: string): void;
  /** Stage everything and commit with a deterministic, increasing date. */
  commit(message: string): string;
}

const cleanups: string[] = [];

function makeRepo(bare = false): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'gbv-it-'));
  cleanups.push(dir);
  const run = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  run('init', '-q', '-b', 'main', ...(bare ? ['--bare'] : []));
  if (!bare) {
    // GitService relies on rename detection for R-status records; pin it
    // repo-locally so a user-global `diff.renames=false` can't flip it.
    run('config', 'diff.renames', 'true');
  }
  const write = (rel: string, content: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const commit = (message: string) => {
    const date = nextStamp();
    execFileSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: dir,
      env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return run('rev-parse', 'HEAD').trim();
  };
  return { dir, service: new GitService(dir), run, write, commit };
}

afterAll(() => {
  for (const dir of cleanups) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// A rich fixture exercising every change shape the UI must display:
//
//   root ── modify+delete+rename ──┬── mainline ── merge   (main)
//                                  └── feature ─────┘      (feature)
// --------------------------------------------------------------------------
describe('real git: commit change information', () => {
  let repo: Repo;
  let rootHash: string;
  let renameHash: string;
  let featureHash: string;
  let mainlineHash: string;
  let mergeHash: string;

  const FEATURE_SUBJECT = 'fix: handle "quotes", commas & <tags>\tplus a tab';

  beforeAll(() => {
    repo = makeRepo();
    repo.write('a.txt', 'line1\n');
    repo.write('src/app.ts', 'console.log(1);\n');
    repo.write('src/util/helper.ts', 'export const helper = 1;\n');
    repo.write('docs/read me.md', '# docs\n');
    repo.write('data/naïve-ünïcode.txt', 'müller\n');
    repo.write('no-newline.txt', 'exact bytes, no trailing newline');
    rootHash = repo.commit('Initial commit\n\nFirst body line.\n\nSecond paragraph.');

    repo.write('a.txt', 'line1\nline2\n');
    rmSync(join(repo.dir, 'docs/read me.md'));
    repo.run('mv', 'src/util/helper.ts', 'src/util/helpers.ts');
    renameHash = repo.commit('Modify, delete and rename');

    repo.run('checkout', '-q', '-b', 'feature');
    repo.write('feature.txt', 'feat\n');
    repo.write('src/app.ts', 'console.log(2);\n');
    featureHash = repo.commit(FEATURE_SUBJECT);

    repo.run('checkout', '-q', 'main');
    repo.write('main-only.txt', 'main\n');
    mainlineHash = repo.commit('Mainline work');

    const date = nextStamp();
    execFileSync('git', ['merge', '-q', '--no-ff', 'feature', '-m', 'Merge branch feature'], {
      cwd: repo.dir,
      env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    mergeHash = repo.run('rev-parse', 'HEAD').trim();
  });

  describe('getCommits', () => {
    it('returns the full graph, newest first, children before parents', async () => {
      const commits = await repo.service.getCommits(100);
      expect(commits).toHaveLength(5);
      expect(commits[0].hash).toBe(mergeHash);
      expect(commits.at(-1)!.hash).toBe(rootHash);

      const index = new Map(commits.map((c, i) => [c.hash, i]));
      for (const c of commits) {
        for (const p of c.parents) {
          expect(index.get(p)!).toBeGreaterThan(index.get(c.hash)!);
        }
      }
    });

    it('wires parents: merge has two, root has none', async () => {
      const commits = await repo.service.getCommits(100);
      const byHash = new Map(commits.map((c) => [c.hash, c]));
      expect(byHash.get(mergeHash)!.parents).toEqual([mainlineHash, featureHash]);
      expect(byHash.get(rootHash)!.parents).toEqual([]);
    });

    it('keeps shell metacharacters and tabs in subjects intact', async () => {
      const commits = await repo.service.getCommits(100);
      expect(commits.map((c) => c.subject)).toContain(FEATURE_SUBJECT);
    });

    it('parses author identity and a strict-ISO date', async () => {
      const [head] = await repo.service.getCommits(1);
      expect(head.authorName).toBe('Ada Lovelace');
      expect(head.authorEmail).toBe('ada@example.com');
      expect(new Date(head.authorDate).getTime()).not.toBeNaN();
    });

    it('decorates tips with their branch names', async () => {
      const commits = await repo.service.getCommits(100);
      const byHash = new Map(commits.map((c) => [c.hash, c]));
      expect(byHash.get(mergeHash)!.refs).toContain('main');
      expect(byHash.get(featureHash)!.refs).toContain('feature');
    });

    it('honours the commit limit, keeping parent hashes that fall outside it', async () => {
      const commits = await repo.service.getCommits(2);
      expect(commits).toHaveLength(2);
      // The merge still reports both parents even though only one is loaded.
      expect(commits[0].parents).toHaveLength(2);
    });

    it('scopes to a ref: feature history excludes mainline commits', async () => {
      const commits = await repo.service.getCommits(100, ['feature']);
      const hashes = commits.map((c) => c.hash);
      expect(hashes).toContain(featureHash);
      expect(hashes).not.toContain(mainlineHash);
      expect(hashes).not.toContain(mergeHash);
    });

    it('loads branch history even if the focused ref was persisted shell-quoted', async () => {
      const repo = makeRepo();
      repo.write('a.txt', 'base\n');
      repo.commit('base');
      repo.run('checkout', '-q', '-b', 'features/net10');
      repo.write('feature.txt', 'net10\n');
      const featureCommit = repo.commit('net10 work');

      const commits = await repo.service.getCommits(100, [`'features/net10'`]);
      expect(commits.map((c) => c.hash)).toContain(featureCommit);
      expect(commits[0].subject).toBe('net10 work');
    });

    it('pages with skip: consecutive pages stitch back into the full list', async () => {
      const all = await repo.service.getCommits(100, ['main']);
      const page1 = await repo.service.getCommits(2, ['main']);
      const page2 = await repo.service.getCommits(2, ['main'], 2);
      const page3 = await repo.service.getCommits(2, ['main'], 4);
      const stitched = [...page1, ...page2, ...page3].map((c) => c.hash);
      expect(stitched).toEqual(all.map((c) => c.hash));
      expect(await repo.service.getCommits(2, ['main'], 100)).toEqual([]);
    });
  });

  describe('getCommitDetail', () => {
    it('lists every file of a root commit as added, with paths verbatim', async () => {
      const d = await repo.service.getCommitDetail(rootHash);
      expect(d.commit.parents).toEqual([]);
      expect(d.files.every((f) => f.status === 'A')).toBe(true);
      const paths = d.files.map((f) => f.path);
      // Unicode and spaces must arrive unquoted, exactly as on disk.
      expect(paths).toContain('data/naïve-ünïcode.txt');
      expect(paths).toContain('docs/read me.md');
      expect(paths).toContain('src/util/helper.ts');
      expect(paths).toHaveLength(6);
    });

    it('separates the subject from a multi-paragraph body', async () => {
      const d = await repo.service.getCommitDetail(rootHash);
      expect(d.commit.subject).toBe('Initial commit');
      expect(d.body).toBe('First body line.\n\nSecond paragraph.');
    });

    it('returns an empty body when there is none', async () => {
      const d = await repo.service.getCommitDetail(mainlineHash);
      expect(d.body).toBe('');
    });

    it('reports modify, delete, and a detected rename structurally', async () => {
      const d = await repo.service.getCommitDetail(renameHash);
      expect(d.files).toEqual(
        expect.arrayContaining([
          { status: 'M', path: 'a.txt' },
          { status: 'D', path: 'docs/read me.md' },
          { status: 'R100', oldPath: 'src/util/helper.ts', path: 'src/util/helpers.ts' },
        ])
      );
      expect(d.files).toHaveLength(3);
    });

    it('shows what a merge brought in (first-parent diff), not an empty combined diff', async () => {
      const d = await repo.service.getCommitDetail(mergeHash);
      expect(d.commit.parents).toEqual([mainlineHash, featureHash]);
      expect(d.files).toEqual(
        expect.arrayContaining([
          { status: 'A', path: 'feature.txt' },
          { status: 'M', path: 'src/app.ts' },
        ])
      );
      expect(d.files).toHaveLength(2);
    });
  });

  describe('getFileAtRef (both sides of the diff editor)', () => {
    it('serves historical content per ref', async () => {
      expect(await repo.service.getFileAtRef(rootHash, 'a.txt')).toBe('line1\n');
      expect(await repo.service.getFileAtRef('HEAD', 'a.txt')).toBe('line1\nline2\n');
    });

    it('returns the blob verbatim, without adding a trailing newline', async () => {
      expect(await repo.service.getFileAtRef('HEAD', 'no-newline.txt')).toBe(
        'exact bytes, no trailing newline'
      );
    });

    it('serves unicode and spaced paths through the shell quoting', async () => {
      expect(await repo.service.getFileAtRef('HEAD', 'data/naïve-ünïcode.txt')).toBe('müller\n');
      expect(await repo.service.getFileAtRef(rootHash, 'docs/read me.md')).toBe('# docs\n');
    });

    it("returns '' for an added file's before-side and a deleted file's after-side", async () => {
      // feature.txt did not exist on the merge's first parent (the left pane).
      expect(await repo.service.getFileAtRef(`${mergeHash}^`, 'feature.txt')).toBe('');
      // docs/read me.md was deleted (the right pane after the delete commit).
      expect(await repo.service.getFileAtRef(renameHash, 'docs/read me.md')).toBe('');
    });

    it('serves a rename: old path on the parent side, new path on the commit side', async () => {
      expect(await repo.service.getFileAtRef(`${renameHash}^`, 'src/util/helper.ts')).toBe(
        'export const helper = 1;\n'
      );
      expect(await repo.service.getFileAtRef(renameHash, 'src/util/helpers.ts')).toBe(
        'export const helper = 1;\n'
      );
      // And each path is absent on the other side.
      expect(await repo.service.getFileAtRef(renameHash, 'src/util/helper.ts')).toBe('');
    });
  });

  describe('compare', () => {
    it('splits commits per side and diffs files against the merge base', async () => {
      const result = await repo.service.compare('feature', 'main');
      // main gained the mainline commit and the merge; feature is fully merged.
      expect(result.ahead.map((c) => c.hash)).toEqual(
        expect.arrayContaining([mainlineHash, mergeHash])
      );
      expect(result.ahead).toHaveLength(2);
      expect(result.behind).toEqual([]);
      // Three-dot diff vs the merge base: only main's own addition shows.
      expect(result.files).toEqual([{ status: 'A', path: 'main-only.txt' }]);
      // feature is fully merged into main, so the merge base is feature's tip.
      expect(result.mergeBase).toBe(featureHash);
    });
  });

  it('getCurrentBranch reports the checked-out branch', async () => {
    expect(await repo.service.getCurrentBranch()).toBe('main');
  });

  it('isDirty is false right after a commit', async () => {
    expect(await repo.service.isDirty()).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Branch listing + remote tracking against a real bare remote.
// --------------------------------------------------------------------------
describe('real git: branches and tracking', () => {
  let repo: Repo;

  beforeAll(() => {
    const bare = makeRepo(true);
    repo = makeRepo();
    repo.write('base.txt', 'base\n');
    repo.commit('base');
    repo.write('second.txt', 'two\n');
    repo.commit('second');
    repo.run('remote', 'add', 'origin', bare.dir);
    repo.run('push', '-q', '-u', 'origin', 'main');
    // Creates refs/remotes/origin/HEAD — must NOT leak into the branch list.
    repo.run('remote', 'set-head', 'origin', '-a');

    // Diverge from upstream: drop the pushed tip (behind 1), commit anew (ahead 1).
    repo.run('reset', '-q', '--hard', 'HEAD~1');
    repo.write('local.txt', 'local\n');
    repo.commit('local work');

    // A branch whose upstream vanished ([gone]).
    repo.run('checkout', '-q', '-b', 'doomed');
    repo.run('push', '-q', '-u', 'origin', 'doomed');
    repo.run('push', '-q', 'origin', ':doomed');
    repo.run('fetch', '-q', '--prune', 'origin');
    repo.run('checkout', '-q', 'main');
  });

  it('lists locals and remotes with kind, head flag and upstream', async () => {
    const branches = await repo.service.getBranches();
    const main = branches.find((b) => b.name === 'main')!;
    expect(main).toMatchObject({
      refName: 'refs/heads/main',
      kind: 'local',
      isHead: true,
      upstream: 'origin/main',
    });
    const remoteMain = branches.find((b) => b.name === 'origin/main')!;
    expect(remoteMain).toMatchObject({
      refName: 'refs/remotes/origin/main',
      kind: 'remote',
      isHead: false,
    });
  });

  it('reports real ahead/behind counts for a diverged branch', async () => {
    const branches = await repo.service.getBranches();
    const main = branches.find((b) => b.name === 'main')!;
    expect(main.ahead).toBe(1);
    expect(main.behind).toBe(1);
  });

  it('keeps a branch with a deleted upstream, at zero counts ([gone])', async () => {
    const branches = await repo.service.getBranches();
    const doomed = branches.find((b) => b.name === 'doomed')!;
    expect(doomed.upstream).toBe('origin/doomed');
    expect(doomed.ahead).toBe(0);
    expect(doomed.behind).toBe(0);
    // The pruned remote ref itself is gone from the list.
    expect(branches.some((b) => b.name === 'origin/doomed')).toBe(false);
  });

  it('filters the symbolic origin/HEAD pointer out of the remote list', async () => {
    const branches = await repo.service.getBranches();
    expect(branches.some((b) => b.refName.endsWith('/HEAD'))).toBe(false);
    expect(branches.some((b) => b.name === 'origin')).toBe(false);
  });

  it('getTracking mirrors the ahead/behind of HEAD vs upstream', async () => {
    expect(await repo.service.getTracking()).toEqual({
      ahead: 1,
      behind: 1,
      upstream: 'origin/main',
    });
  });

  it('getRemotes lists configured remotes', async () => {
    expect(await repo.service.getRemotes()).toEqual(['origin']);
  });

  it('pushSetUpstream publishes a new branch and wires its upstream', async () => {
    repo.run('checkout', '-q', '-b', 'publish-me');
    try {
      await repo.service.pushSetUpstream('publish-me', 'origin');
      const branches = await repo.service.getBranches();
      const local = branches.find((b) => b.name === 'publish-me')!;
      expect(local.upstream).toBe('origin/publish-me');
      expect(branches.some((b) => b.name === 'origin/publish-me')).toBe(true);
    } finally {
      repo.run('checkout', '-q', 'main');
    }
  });
});

// --------------------------------------------------------------------------
// Working-tree state + write operations (each test owns its repo — they mutate).
// --------------------------------------------------------------------------
describe('real git: working tree and write operations', () => {
  it('isDirty sees untracked, staged, and modified-tracked files', async () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a\n');
    repo.commit('init');
    expect(await repo.service.isDirty()).toBe(false);

    repo.write('untracked.txt', 'new\n');
    expect(await repo.service.isDirty()).toBe(true);

    repo.run('add', 'untracked.txt'); // staged, nothing unstaged
    expect(await repo.service.isDirty()).toBe(true);

    repo.commit('add it');
    repo.write('a.txt', 'changed\n'); // modified tracked file
    expect(await repo.service.isDirty()).toBe(true);
  });

  it('survives branch names with quotes through the shell (create/checkout/delete)', async () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a\n');
    repo.commit('init');

    const tricky = "wip/ada's-fix";
    await repo.service.createBranch(tricky);
    expect(await repo.service.getCurrentBranch()).toBe(tricky);

    await repo.service.checkout('main');
    await repo.service.deleteBranch(tricky);
    const branches = await repo.service.getBranches();
    expect(branches.some((b) => b.name === tricky)).toBe(false);
  });

  it('refuses to delete an unmerged branch unless forced', async () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a\n');
    repo.commit('init');
    await repo.service.createBranch('unmerged');
    repo.write('b.txt', 'b\n');
    repo.commit('only here');
    await repo.service.checkout('main');

    await expect(repo.service.deleteBranch('unmerged')).rejects.toThrow();
    await repo.service.deleteBranch('unmerged', true);
    expect((await repo.service.getBranches()).some((b) => b.name === 'unmerged')).toBe(false);
  });

  it('merge brings the other branch in', async () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a\n');
    repo.commit('init');
    await repo.service.createBranch('topic');
    repo.write('topic.txt', 'topic\n');
    repo.commit('topic work');
    await repo.service.checkout('main');

    await repo.service.merge('topic');
    expect(await repo.service.getFileAtRef('HEAD', 'topic.txt')).toBe('topic\n');
  });
});

// --------------------------------------------------------------------------
// Odd repository states the UI must not fall over on.
// --------------------------------------------------------------------------
describe('real git: edge-case repository states', () => {
  it('handles a freshly-initialised repo with no commits', async () => {
    const repo = makeRepo();
    expect(await repo.service.getBranches()).toEqual([]);
    // rev-parse HEAD fails before the first commit; the service degrades to ''.
    expect(await repo.service.getCurrentBranch()).toBe('');
    expect(await repo.service.getTracking()).toEqual({ ahead: 0, behind: 0 });
    repo.write('a.txt', 'a\n');
    expect(await repo.service.isDirty()).toBe(true);
  });

  it('handles a detached HEAD', async () => {
    const repo = makeRepo();
    repo.write('a.txt', 'a\n');
    const first = repo.commit('one');
    repo.write('a.txt', 'b\n');
    repo.commit('two');
    repo.run('checkout', '-q', first);

    expect(await repo.service.getCurrentBranch()).toBe('HEAD');
    const branches = await repo.service.getBranches();
    expect(branches.some((b) => b.isHead)).toBe(false);
    // History and commit details still work from the detached position.
    const commits = await repo.service.getCommits(10);
    expect(commits).toHaveLength(2);
    expect((await repo.service.getCommitDetail(first)).files).toEqual([
      { status: 'A', path: 'a.txt' },
    ]);
  });

  it('findRepoRoot resolves the root from a nested folder and rejects non-repos', async () => {
    const repo = makeRepo();
    repo.write('deep/nested/file.txt', 'x\n');
    repo.commit('init');
    const fromNested = await GitService.findRepoRoot(join(repo.dir, 'deep/nested'));
    // Compare via git itself to dodge /tmp symlink differences (e.g. /private/tmp).
    expect(fromNested).toBe(repo.run('rev-parse', '--show-toplevel').trim());

    const notARepo = mkdtempSync(join(tmpdir(), 'gbv-norepo-'));
    cleanups.push(notARepo);
    expect(await GitService.findRepoRoot(notARepo)).toBeUndefined();
  });

  describe('getGitDirs (worktree/packed-ref watching)', () => {
    it('returns a single .git for a normal repo, and undefined for a non-repo', async () => {
      const repo = makeRepo();
      repo.write('a.txt', 'a\n');
      repo.commit('init');

      const dirs = await GitService.getGitDirs(repo.dir);
      expect(dirs).toBeDefined();
      expect(isAbsolute(dirs!.gitDir)).toBe(true);
      // A normal checkout's git dir and common dir are the same `.git` folder.
      expect(dirs!.gitDir).toBe(dirs!.commonDir);
      expect(basename(dirs!.gitDir)).toBe('.git');
      // Matches git's own answer (sidesteps /tmp symlink differences).
      expect(dirs!.gitDir).toBe(repo.run('rev-parse', '--absolute-git-dir').trim());

      const notARepo = mkdtempSync(join(tmpdir(), 'gbv-norepo-'));
      cleanups.push(notARepo);
      expect(await GitService.getGitDirs(notARepo)).toBeUndefined();
    });

    it('resolves a linked worktree to its own git dir plus the shared common dir', async () => {
      const repo = makeRepo();
      repo.write('a.txt', 'a\n');
      repo.commit('init');

      // `git worktree add` creates the directory; keep it out of the workspace.
      const wtPath = `${repo.dir}-wt`;
      cleanups.push(wtPath);
      repo.run('worktree', 'add', wtPath, '-b', 'wt');

      const dirs = await GitService.getGitDirs(wtPath);
      expect(dirs).toBeDefined();
      expect(isAbsolute(dirs!.gitDir)).toBe(true);
      expect(isAbsolute(dirs!.commonDir)).toBe(true);
      // The worktree's git dir lives under <main>/.git/worktrees/<name> …
      expect(dirs!.gitDir).toContain(`${sep}worktrees${sep}`);
      expect(dirs!.gitDir).toBe(repo.run('-C', wtPath, 'rev-parse', '--absolute-git-dir').trim());
      // … while the common dir is the main repo's shared `.git`.
      expect(dirs!.commonDir).not.toBe(dirs!.gitDir);
      expect(basename(dirs!.commonDir)).toBe('.git');
    });
  });
});

// --------------------------------------------------------------------------
// Security: a ref/range that LOOKS like a git option (e.g. "--output=FILE")
// must never be parsed as one. `git log --output=FILE` writes its output to
// FILE, so without `--end-of-options` an attacker-named ref would be an
// arbitrary-file-write primitive. These run real git and assert the side
// effect (a written file) never happens.
// --------------------------------------------------------------------------
describe('real git: option-injection refs cannot write files', () => {
  let repo: Repo;
  let sentinel: string;

  beforeAll(() => {
    repo = makeRepo();
    repo.write('a.txt', 'one\n');
    repo.commit('first');
    repo.write('a.txt', 'two\n');
    repo.commit('second');
    sentinel = join(repo.dir, 'PWNED');
  });

  const noFileWritten = () => expect(existsSync(sentinel)).toBe(false);

  it('getCommits refuses an --output= ref instead of writing the file', async () => {
    await expect(repo.service.getCommits(10, [`--output=${sentinel}`])).rejects.toThrow();
    noFileWritten();
  });

  it('compare refuses an --output= base/target instead of writing the file', async () => {
    await expect(repo.service.compare(`--output=${sentinel}`, 'main')).rejects.toThrow();
    await expect(repo.service.compare('main', `--output=${sentinel}`)).rejects.toThrow();
    noFileWritten();
  });

  it('getCommitDetail refuses an --output= hash instead of writing the file', async () => {
    await expect(repo.service.getCommitDetail(`--output=${sentinel}`)).rejects.toThrow();
    noFileWritten();
  });

  it('getFileAtRef swallows an --output= ref and returns empty (no file written)', async () => {
    expect(await repo.service.getFileAtRef(`--output=${sentinel}`, 'a.txt')).toBe('');
    noFileWritten();
  });

  it('a real ref of the same shape still resolves normally', async () => {
    // Sanity: --end-of-options doesn't break legitimate history reads.
    const commits = await repo.service.getCommits(10, ['main']);
    expect(commits.map((c) => c.subject)).toEqual(['second', 'first']);
    noFileWritten();
  });
});
