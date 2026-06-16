import { describe, expect, it } from 'vitest';
import {
  GitService,
  assertNotOption,
  localBranchName,
  normalizeRefArgument,
  parseRefs,
  parseTrack,
  type GitExecFn,
} from './gitService';

const NUL = '\x00';
const RS = '\x1e';

/**
 * GitService wired to canned output, recording every command it runs as an argv
 * ARRAY (no shell, no quoting). The one-time `git --version` capability probe is
 * answered from `version` (a modern git by default, so `--end-of-options` is
 * used) and is NOT recorded, so command-index assertions stay stable.
 *
 * `responses` are still keyed/matched against a `git <args joined by space>`
 * string for ergonomics; only the recorded `commands` are arrays.
 */
function fakeGit(
  responses: Record<string, string> | ((cmd: string) => string),
  version = '2.51.0'
) {
  const commands: string[][] = [];
  const exec: GitExecFn = async (args) => {
    const joined = `git ${args.join(' ')}`;
    if (joined === 'git --version') {
      return { stdout: `git version ${version}\n` };
    }
    commands.push(args);
    const out =
      typeof responses === 'function'
        ? responses(joined)
        : Object.entries(responses).find(([prefix]) => joined.startsWith(prefix))?.[1];
    if (out === undefined) {
      throw new Error(`unexpected command: ${joined}`);
    }
    return { stdout: out };
  };
  return { git: new GitService('/repo', undefined, exec), commands };
}

describe('parseTrack', () => {
  it('parses ahead/behind in all combinations', () => {
    expect(parseTrack('[ahead 2]')).toEqual({ ahead: 2, behind: 0 });
    expect(parseTrack('[behind 3]')).toEqual({ ahead: 0, behind: 3 });
    expect(parseTrack('[ahead 2, behind 3]')).toEqual({ ahead: 2, behind: 3 });
    expect(parseTrack('[gone]')).toEqual({ ahead: 0, behind: 0 });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0 });
  });
});

describe('parseRefs', () => {
  it('splits decorations, unwraps HEAD ->, and drops tags', () => {
    expect(parseRefs('HEAD -> main, origin/main, tag: v1.0')).toEqual(['main', 'origin/main']);
    expect(parseRefs('')).toEqual([]);
  });
});

describe('normalizeRefArgument', () => {
  it('unwraps a legacy shell-quoted persisted ref so argv passes it cleanly', () => {
    expect(normalizeRefArgument(`'features/net10'`)).toBe('features/net10');
    expect(normalizeRefArgument(`'wip/ada'\\''s-fix'`)).toBe("wip/ada's-fix");
  });

  it('leaves non-wrapper quote characters untouched', () => {
    expect(normalizeRefArgument("wip/ada's-fix")).toBe("wip/ada's-fix");
    expect(normalizeRefArgument("feature/'draft")).toBe("feature/'draft");
  });
});

describe('GitService.getBranches', () => {
  it('parses local and remote branches with tracking info', async () => {
    const line = (f: string[]) => f.join(NUL);
    const out = [
      line(['refs/heads/main', 'main', 'aaa', 'origin/main', '[ahead 1, behind 2]', '*']),
      line(['refs/heads/dev', 'dev', 'bbb', '', '', ' ']),
      line(['refs/remotes/origin/main', 'origin/main', 'aaa', '', '', ' ']),
      line(['refs/remotes/origin/HEAD', 'origin', 'aaa', '', '', ' ']),
    ].join('\n');
    const { git } = fakeGit({ 'git for-each-ref': out });

    const branches = await git.getBranches();
    expect(branches.map((b) => b.name)).toEqual(['main', 'dev', 'origin/main']);
    expect(branches[0]).toMatchObject({
      kind: 'local',
      isHead: true,
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
    });
    expect(branches[2].kind).toBe('remote');
    // The symbolic origin/HEAD pointer must not leak through.
    expect(branches.some((b) => b.refName.endsWith('/HEAD'))).toBe(false);
  });
});

describe('GitService.getCommits', () => {
  const record = (f: string[]) => f.join(NUL) + RS;

  it('parses records split on the RS separator', async () => {
    const out =
      record(['h1', 'h2 h3', 'Ada', 'ada@x', '2026-01-02T03:04:05+00:00', 'Merge it', 'HEAD -> main, tag: v1']) +
      '\n' +
      record(['h2', '', 'Bob', 'bob@x', '2026-01-01T00:00:00+00:00', 'Root', '']);
    const { git, commands } = fakeGit({ 'git log': out });

    const commits = await git.getCommits(100);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: 'h1',
      shortHash: 'h1',
      parents: ['h2', 'h3'],
      subject: 'Merge it',
      refs: ['main'],
    });
    expect(commits[1].parents).toEqual([]);
    // Default scope is all branches + remotes.
    expect(commands[0]).toContain('--branches');
    expect(commands[0]).toContain('--remotes');
    expect(commands[0]).toContain('--max-count=100');
  });

  it('passes each requested ref as its own argv element after the marker', async () => {
    const { git, commands } = fakeGit({ 'git log': '' });
    await git.getCommits(10, ['feature/x']);
    expect(commands[0]).toContain('feature/x');
    expect(commands[0].indexOf('--end-of-options')).toBeLessThan(
      commands[0].indexOf('feature/x')
    );
  });

  it('does not pass stale shell quotes through to git when scoping branch history', async () => {
    const { git, commands } = fakeGit({ 'git log': '' });
    await git.getCommits(10, [`'features/net10'`]);
    // The legacy single-quoted value is unwrapped to the bare ref.
    expect(commands[0]).toContain('features/net10');
    expect(commands[0]).not.toContain(`'features/net10'`);
    expect(commands[0]).toContain('--end-of-options');
  });

  it('passes --skip when paging, and omits it for the first page', async () => {
    const { git, commands } = fakeGit({ 'git log': '' });
    await git.getCommits(10, ['main'], 30);
    await git.getCommits(10, ['main']);
    expect(commands[0]).toContain('--skip=30');
    expect(commands[0]).toContain('--max-count=10');
    expect(commands[1].some((a) => a.startsWith('--skip'))).toBe(false);
  });
});

describe('GitService.getTracking', () => {
  it('parses left-right counts (behind first, ahead second)', async () => {
    const { git } = fakeGit((cmd) =>
      cmd.includes('rev-parse') ? 'origin/main\n' : '3\t5\n'
    );
    expect(await git.getTracking()).toEqual({ ahead: 5, behind: 3, upstream: 'origin/main' });
  });

  it('returns zeros when there is no upstream', async () => {
    const exec: GitExecFn = async () => {
      throw new Error('no upstream');
    };
    const git = new GitService('/repo', undefined, exec);
    expect(await git.getTracking()).toEqual({ ahead: 0, behind: 0 });
  });
});

describe('GitService.pull', () => {
  it('passes the reconciliation flag for each strategy', async () => {
    const { git, commands } = fakeGit({ 'git pull': '' });
    await git.pull('merge');
    await git.pull('rebase');
    await git.pull('ff-only');
    expect(commands).toEqual([
      ['pull', '--no-rebase'],
      ['pull', '--rebase'],
      ['pull', '--ff-only'],
    ]);
  });
});

describe('GitService.compare', () => {
  it('passes the range unquoted and parses NUL-separated name-status output', async () => {
    const { git, commands } = fakeGit((cmd) => {
      if (cmd.startsWith('git log')) {
        return '';
      }
      if (cmd.startsWith('git merge-base')) {
        return 'feedc0de1234\n';
      }
      return `M${NUL}src/a.ts${NUL}A${NUL}docs/new.md${NUL}`;
    });
    const result = await git.compare('main', 'dev');
    expect(result.files).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'docs/new.md' },
    ]);
    expect(result.mergeBase).toBe('feedc0de1234');
    // The log range is a single argv element containing the `..` operator.
    expect(commands[0]).toContain('main..dev');
    expect(commands[1]).toContain('dev..main');
    expect(commands[2]).toEqual(['merge-base', '--end-of-options', 'main', 'dev']);
    // The file diff must use -z so odd paths arrive unquoted, and pin the refs
    // behind --end-of-options so an option-looking ref can't inject an option.
    expect(commands[3]).toEqual([
      'diff',
      '--name-status',
      '-z',
      '--end-of-options',
      'main...dev',
    ]);
  });
});

describe('GitService.getCommitDetail', () => {
  /** Wire up the three commands getCommitDetail runs, keyed by shape. */
  const detailGit = (over: {
    meta: string[];
    body?: string;
    files?: string;
    expectFilesCmd?: (cmd: string) => boolean;
  }) =>
    fakeGit((cmd) => {
      if (cmd.includes('--format=%b')) {
        return over.body ?? '';
      }
      if (cmd.startsWith('git show -s')) {
        return over.meta.join(NUL) + '\n';
      }
      return over.files ?? '';
    });

  const meta = (hash: string, parents: string) => [
    hash,
    parents,
    'Ada',
    'ada@x',
    '2026-01-02T03:04:05+00:00',
    'Change things',
    'HEAD -> main, tag: v1',
  ];

  it('parses metadata, multiline body, and changed files', async () => {
    const { git } = detailGit({
      meta: meta('abcdef0123456789', 'p1'),
      body: 'First line.\n\nSecond paragraph.\n',
      files: `M${NUL}src/a.ts${NUL}A${NUL}docs/with space.md${NUL}`,
    });
    const d = await git.getCommitDetail('abcdef0123456789');
    expect(d.commit).toMatchObject({
      hash: 'abcdef0123456789',
      shortHash: 'abcdef01',
      parents: ['p1'],
      subject: 'Change things',
      refs: ['main'],
    });
    expect(d.body).toBe('First line.\n\nSecond paragraph.');
    expect(d.files).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'docs/with space.md' },
    ]);
  });

  it('diffs a normal commit against its first parent with -z', async () => {
    const { git, commands } = detailGit({ meta: meta('aaa', 'p1') });
    await git.getCommitDetail('aaa');
    expect(commands[2]).toEqual(['diff', '--name-status', '-z', '--end-of-options', 'aaa^', 'aaa']);
  });

  it('diffs a merge commit against its FIRST parent (not the combined diff)', async () => {
    // `git show` on a merge emits the combined diff, which is empty for a
    // clean merge — the file list must come from the first-parent diff
    // instead, matching what the diff editor opens.
    const { git, commands } = detailGit({
      meta: meta('mmm', 'p1 p2'),
      files: `A${NUL}feature.txt${NUL}`,
    });
    const d = await git.getCommitDetail('mmm');
    expect(d.commit.parents).toEqual(['p1', 'p2']);
    expect(commands[2]).toEqual(['diff', '--name-status', '-z', '--end-of-options', 'mmm^', 'mmm']);
    expect(d.files).toEqual([{ status: 'A', path: 'feature.txt' }]);
  });

  it('uses `show` (diff vs the empty tree) for a root commit', async () => {
    const { git, commands } = detailGit({
      meta: meta('r00t', ''),
      files: `A${NUL}a.txt${NUL}`,
    });
    const d = await git.getCommitDetail('r00t');
    expect(d.commit.parents).toEqual([]);
    expect(commands[2]).toEqual([
      'show',
      '--name-status',
      '-z',
      '--format=',
      '--end-of-options',
      'r00t',
    ]);
    expect(d.files).toEqual([{ status: 'A', path: 'a.txt' }]);
  });

  it('preserves rename and copy records structurally and keeps the score', async () => {
    const { git } = detailGit({
      meta: meta('aaa', 'p1'),
      files: [
        'R100', 'src/old name.ts', 'src/new name.ts',
        'C75', 'lib/base.ts', 'lib/copy.ts',
        'M', 'kept.ts',
      ].join(NUL) + NUL,
    });
    const d = await git.getCommitDetail('aaa');
    expect(d.files).toEqual([
      { status: 'R100', oldPath: 'src/old name.ts', path: 'src/new name.ts' },
      { status: 'C75', oldPath: 'lib/base.ts', path: 'lib/copy.ts' },
      { status: 'M', path: 'kept.ts' },
    ]);
  });

  it('keeps non-ASCII and tab-containing paths verbatim (no C-quoting with -z)', async () => {
    const { git } = detailGit({
      meta: meta('aaa', 'p1'),
      files: `A${NUL}data/naïve-ünïcode.txt${NUL}M${NUL}weird\tname.txt${NUL}`,
    });
    const d = await git.getCommitDetail('aaa');
    expect(d.files.map((f) => f.path)).toEqual(['data/naïve-ünïcode.txt', 'weird\tname.txt']);
  });

  it('returns an empty file list for an empty commit', async () => {
    const { git } = detailGit({ meta: meta('aaa', 'p1'), files: '' });
    expect((await git.getCommitDetail('aaa')).files).toEqual([]);
  });
});

describe('GitService.getFileAtRef', () => {
  it('passes ref:path as one argv element and returns the blob verbatim', async () => {
    const { git, commands } = fakeGit({ 'git show': 'const x = 1;\n' });
    const out = await git.getFileAtRef('abc123', 'src/with space/naïve.ts');
    expect(out).toBe('const x = 1;\n');
    expect(commands[0]).toEqual(['show', '--end-of-options', 'abc123:src/with space/naïve.ts']);
  });

  it('returns the empty string when the path is missing on that side', async () => {
    const exec: GitExecFn = async () => {
      throw new Error('fatal: path does not exist');
    };
    const git = new GitService('/repo', undefined, exec);
    expect(await git.getFileAtRef('abc', 'gone.txt')).toBe('');
  });
});

describe('argument/option injection hardening', () => {
  it('localBranchName unwraps full local refs for checkout/branch commands', () => {
    expect(localBranchName('refs/heads/feature/x')).toBe('feature/x');
    expect(localBranchName('refs/remotes/origin/main')).toBe('refs/remotes/origin/main');
  });

  it('assertNotOption rejects dash-led values and accepts normal ones', () => {
    expect(() => assertNotOption('--upload-pack=touch x', 'branch name')).toThrow(/branch name/);
    expect(() => assertNotOption('-d')).toThrow();
    expect(() => assertNotOption('feature/x')).not.toThrow();
    expect(() => assertNotOption('main')).not.toThrow();
  });

  it('places caller-supplied refs after --end-of-options in git log', async () => {
    const { git, commands } = fakeGit({ 'git log': '' });
    await git.getCommits(10, ['--output=/tmp/pwned']);
    // The malicious ref sits AFTER the marker, so git can never read it as the
    // --output option; --branches/--remotes are real options and stay before.
    expect(commands[0]).toContain('--end-of-options');
    expect(commands[0]).toContain('--output=/tmp/pwned');
    expect(commands[0].indexOf('--end-of-options')).toBeLessThan(
      commands[0].indexOf('--output=/tmp/pwned')
    );
  });

  it('guards every ref-bearing read/write command with --end-of-options', async () => {
    const responses = (cmd: string) => {
      if (cmd.startsWith('git show -s')) {
        return ['h', '', 'A', 'a@x', '2026-01-01T00:00:00Z', 's', ''].join(NUL) + '\n';
      }
      return '';
    };
    const { git, commands } = fakeGit(responses);

    await git.merge('dev');
    await git.deleteBranch('old');
    await git.deleteBranch('old', true);
    await git.getFileAtRef('HEAD', 'a.ts');
    await git.pushSetUpstream('feature', 'origin');
    await git.getCommitDetail('abc');

    expect(commands).toEqual(
      expect.arrayContaining([
        ['merge', '--end-of-options', 'dev'],
        ['branch', '-d', '--end-of-options', 'old'],
        ['branch', '-D', '--end-of-options', 'old'],
        ['show', '--end-of-options', 'HEAD:a.ts'],
        ['push', '--set-upstream', '--end-of-options', 'origin', 'feature'],
      ])
    );
    // getCommitDetail's metadata, body, and diff all carry the marker too.
    expect(
      commands.some((c) => c[0] === 'show' && c[1] === '-s' && c.includes('--end-of-options'))
    ).toBe(true);
  });

  it('checkout never uses --end-of-options (git <= 2.43 parses it as a pathspec)', async () => {
    // `git checkout` ignored --end-of-options in its branch/pathspec
    // disambiguation until git ~2.44, so on 2.43.0 (Ubuntu 24.04 LTS) the marker
    // becomes a bogus pathspec ("did not match any file(s)"). checkout must run
    // the bare ref on EVERY git version, modern probe result notwithstanding.
    const { git, commands } = fakeGit({ 'git checkout': '' }, '2.51.0');
    await git.checkout('feature/test');
    expect(commands[0]).toEqual(['checkout', 'feature/test']);
    expect(commands[0]).not.toContain('--end-of-options');
  });

  it('checkout accepts a full local ref without detaching HEAD', async () => {
    const { git, commands } = fakeGit({ 'git checkout': '' }, '2.51.0');
    await git.checkout('refs/heads/feature/test');
    expect(commands[0]).toEqual(['checkout', 'feature/test']);
  });

  it('checkout rejects an option-looking branch instead of shelling out', async () => {
    // With no marker, checkout falls back to assertNotOption, so an option-named
    // ref is refused before any git runs (git itself forbids '-'-led ref names).
    const { git, commands } = fakeGit({ 'git checkout': '' });
    await expect(git.checkout('--orphan')).rejects.toThrow(/branch/);
    expect(commands).toHaveLength(0);
  });

  it('on git < 2.24 omits --end-of-options but still runs legitimate refs', async () => {
    // Older git treats --end-of-options as a pathspec ("did not match any
    // file(s)"), so the marker must be dropped — a real ref runs without it.
    const { git, commands } = fakeGit({ 'git merge': '' }, '2.23.4');
    await git.merge('main');
    expect(commands[0]).toEqual(['merge', 'main']);
    expect(commands[0]).not.toContain('--end-of-options');
  });

  it('on git < 2.24 rejects an option-looking ref instead of shelling out', async () => {
    // With no marker available the protection falls back to assertNotOption, so
    // an --output= ref is refused before any git runs.
    const { git, commands } = fakeGit({ 'git log': '' }, '2.23.4');
    await expect(git.getCommits(10, ['--output=/tmp/pwned'])).rejects.toThrow(/ref/);
    expect(commands).toHaveLength(0);
  });

  it('createBranch refuses an option-like name or start point (never shells out)', async () => {
    const { git, commands } = fakeGit({ 'git checkout': '' });
    await expect(git.createBranch('--orphan')).rejects.toThrow(/branch name/);
    await expect(git.createBranch('ok', '--start')).rejects.toThrow(/start point/);
    expect(commands).toHaveLength(0); // rejected before any git ran

    await git.createBranch('feature/x', 'main');
    expect(commands[0]).toEqual(['checkout', '-b', 'feature/x', 'main']);
  });
});
