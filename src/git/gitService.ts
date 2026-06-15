import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Field/record separators used to split git's OUTPUT. These are the real bytes.
 * NUL and RS (record separator) never occur inside commit metadata or ref names.
 */
const FIELD_SEP = '\x00'; // NUL
const RECORD_SEP = '\x1e'; // record separator

/**
 * Git format placeholders that make git EMIT the separators above in its output.
 * We must never put a raw NUL byte in the command string itself — it would
 * truncate the shell command. So the format string carries placeholder *text*
 * and git renders the real bytes. Note the syntax differs per subcommand:
 *   - `git log --format` understands the hex escape `%x00` / `%x1e`.
 *   - `git for-each-ref --format` understands `%00` but NOT `%x00`.
 */
const FMT_FIELD_LOG = '%x00';
const FMT_REC_LOG = '%x1e';
const FMT_FIELD_REF = '%00';

/**
 * git's "stop parsing options here" marker. Everything after it is treated as a
 * revision/path, never as an option — even if it begins with a dash. We place
 * it before every externally-derived ref/range argument so a value like
 * `--output=/path` (creatable as a ref name in a malicious repository, or
 * arriving through a compare range) can never be parsed as a git option, which
 * would otherwise be an arbitrary-file-write / argument-injection primitive.
 * Shell-quoting (see `quote`) stops shell metacharacter injection but does NOT
 * stop git's own option parsing — this does. Supported by git since 2.24; on
 * older git the token is unknown and would be parsed as a pathspec (the
 * "did not match any file(s)" error), so `refBarrier()` omits it there and
 * falls back to `assertNotOption()` validation to keep the same protection.
 */
const END_OF_OPTIONS = '--end-of-options';

export interface BranchInfo {
  /** Full ref name, e.g. refs/heads/main or refs/remotes/origin/main. */
  refName: string;
  /** Short, human-friendly name, e.g. main or origin/main. */
  name: string;
  /** Commit hash the ref points at. */
  commit: string;
  /** 'local' | 'remote'. */
  kind: 'local' | 'remote';
  /** Upstream short name for local branches (e.g. origin/main), if any. */
  upstream?: string;
  /** Ahead count vs upstream (outgoing). */
  ahead?: number;
  /** Behind count vs upstream (incoming). */
  behind?: number;
  /** True if this is the currently checked-out branch. */
  isHead: boolean;
}

export interface CommitInfo {
  hash: string;
  /** Abbreviated hash for display. */
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** ISO 8601 author date. */
  authorDate: string;
  subject: string;
  /** Decoration refs attached to this commit (branch names). */
  refs: string[];
}

/**
 * How `git pull` reconciles a divergent branch (local and upstream have both
 * advanced). Maps 1:1 to git's own choices: 'merge' → --no-rebase,
 * 'rebase' → --rebase, 'ff-only' → --ff-only.
 */
export type PullStrategy = 'merge' | 'rebase' | 'ff-only';

export interface CompareResult {
  /** Commits in `target` not in `base` (would be merged in). */
  ahead: CommitInfo[];
  /** Commits in `base` not in `target`. */
  behind: CommitInfo[];
  /** Files changed between base and target. */
  files: { status: string; path: string }[];
  /**
   * The merge-base of the two refs — the diff baseline. The file list is a
   * three-dot diff (base...target), so per-file diffs must use this as their
   * left side to match it.
   */
  mergeBase: string;
}

export interface CommitDetail {
  commit: CommitInfo;
  body: string;
  files: { status: string; path: string }[];
}

/**
 * Minimal logging sink. Deliberately a structural subset of
 * `vscode.LogOutputChannel` (`info`/`error`) so the panel can pass a real
 * output channel straight in, while this module stays free of any `vscode`
 * import and remains independently testable.
 */
export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * Thin wrapper around the git CLI. All commands run with `cwd` set to the
 * repository root. We deliberately use the CLI (not VS Code's Git extension
 * API) because we need full control over `git log` graph/format output and
 * comparison ranges.
 */
/**
 * Shape of the exec function GitService shells out through. Injectable so unit
 * tests can feed canned git output without spawning processes; defaults to the
 * real promisified `child_process.exec`.
 */
export type GitExecFn = (
  command: string,
  options: { cwd: string; maxBuffer: number; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string }>;

export class GitService {
  constructor(
    private readonly repoRoot: string,
    private readonly logger?: Logger,
    private readonly execFn: GitExecFn = execAsync
  ) {}

  private async git(args: string): Promise<string> {
    const start = Date.now();
    try {
      const { stdout } = await this.execFn(`git ${args}`, {
        cwd: this.repoRoot,
        maxBuffer: 64 * 1024 * 1024,
        // Keep output stable/parseable regardless of user config.
        env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' },
      });
      this.logger?.info(`> git ${args} [${Date.now() - start}ms]`);
      return stdout;
    } catch (err) {
      this.logger?.error(`> git ${args} [${Date.now() - start}ms]\n${String(err)}`);
      throw err;
    }
  }

  /** Cached result of the one-time `--end-of-options` capability probe. */
  private endOfOptionsSupport?: Promise<boolean>;

  /**
   * Whether this git understands `--end-of-options` (added in 2.24). Probed
   * once per service via `git --version` and cached; on any probe failure we
   * assume support (the safer default — it can't manufacture the "did not
   * match any file(s)" error, and a git too broken to report its version
   * wouldn't run any command anyway).
   */
  private supportsEndOfOptions(): Promise<boolean> {
    if (!this.endOfOptionsSupport) {
      this.endOfOptionsSupport = this.detectEndOfOptions();
    }
    return this.endOfOptionsSupport;
  }

  private async detectEndOfOptions(): Promise<boolean> {
    try {
      const { stdout } = await this.execFn('git --version', {
        cwd: this.repoRoot,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' },
      });
      const m = /version (\d+)\.(\d+)/.exec(stdout);
      if (!m) {
        return true;
      }
      const major = Number(m[1]);
      const minor = Number(m[2]);
      return major > 2 || (major === 2 && minor >= 24);
    } catch {
      return true;
    }
  }

  /**
   * The option/positional barrier placed before externally-derived refs in a
   * command (trailing space included so it slots straight in front of the
   * first quoted ref). On git >= 2.24 it's the `--end-of-options` marker, which
   * lets even an option-looking ref pass safely as a positional. Older git
   * doesn't know the marker and would treat it as a pathspec ("did not match
   * any file(s)" — the very error this guards against), so there we omit it and
   * instead reject any ref that looks like an option, preserving the
   * argument-injection protection at the cost of refusing the (almost always
   * malicious) option-named ref.
   */
  private async refBarrier(...refs: string[]): Promise<string> {
    if (await this.supportsEndOfOptions()) {
      return `${END_OF_OPTIONS} `;
    }
    for (const ref of refs) {
      assertNotOption(ref, 'ref');
    }
    return '';
  }

  /** Resolve the repository root for an arbitrary folder inside a repo. */
  static async findRepoRoot(folder: string, logger?: Logger): Promise<string | undefined> {
    const args = 'rev-parse --show-toplevel';
    const start = Date.now();
    try {
      const { stdout } = await execAsync(`git ${args}`, {
        cwd: folder,
        env: { ...process.env, LC_ALL: 'C' },
      });
      logger?.info(`> git ${args} (in ${folder}) [${Date.now() - start}ms]`);
      return stdout.trim() || undefined;
    } catch (err) {
      logger?.error(`> git ${args} (in ${folder}) [${Date.now() - start}ms]\n${String(err)}`);
      return undefined;
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const out = await this.git('rev-parse --abbrev-ref HEAD');
      return out.trim();
    } catch {
      return '';
    }
  }

  /**
   * List local and remote branches in one pass using for-each-ref. Tracking
   * info (ahead/behind) is parsed from %(upstream:track).
   */
  async getBranches(): Promise<BranchInfo[]> {
    const fmt = [
      '%(refname)',
      '%(refname:short)',
      '%(objectname)',
      '%(upstream:short)',
      '%(upstream:track)',
      '%(HEAD)',
    ].join(FMT_FIELD_REF);

    const out = await this.git(
      `for-each-ref --format="${fmt}" refs/heads refs/remotes`
    );

    const branches: BranchInfo[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [refName, name, commit, upstream, track, head] = line.split(FIELD_SEP);

      const kind: BranchInfo['kind'] = refName.startsWith('refs/remotes/')
        ? 'remote'
        : 'local';

      // Skip the symbolic origin/HEAD pointer. Git shortens
      // refs/remotes/origin/HEAD to just "origin" (not "origin/HEAD"), so the
      // short name never ends in "/HEAD" — test the full ref name instead, or
      // it leaks through as a remote branch with an empty display name.
      if (kind === 'remote' && refName.endsWith('/HEAD')) {
        continue;
      }

      const { ahead, behind } = parseTrack(track);

      branches.push({
        refName,
        name,
        commit,
        kind,
        upstream: upstream || undefined,
        ahead,
        behind,
        isHead: head === '*',
      });
    }
    return branches;
  }

  /**
   * Load the commit graph. When `refs` is provided we limit to those refs,
   * otherwise we load --all. Parents are included so the webview can lay out
   * the graph lanes itself. `skip` pages past already-loaded commits
   * (`--skip`), so the webview can fetch history incrementally on scroll.
   */
  async getCommits(limit: number, refs?: string[], skip = 0): Promise<CommitInfo[]> {
    const normalizedRefs = refs?.map(normalizeRefArgument);
    const fmt = [
      '%H', // full hash
      '%P', // parent hashes
      '%an', // author name
      '%ae', // author email
      '%aI', // author date, strict ISO
      '%s', // subject
      '%D', // ref names
    ].join(FMT_FIELD_LOG);

    // --author-date-order, not --topo-order: the list's Date column shows the
    // author date, so sorting by it keeps the visible list monotonic, and the
    // --max-count window is the newest N commits (topo-order groups whole
    // lineages, which both reorders rows against the Date column and can push
    // recent commits of a parallel branch past the cutoff entirely). Children
    // still always appear before parents, which is all the lane layout needs.
    const skipArg = skip > 0 ? ` --skip=${Math.floor(skip)}` : '';
    // Options FIRST, then the refs after `--end-of-options`, so a ref that
    // looks like a git option can't be parsed as one (argument injection).
    // `--branches --remotes` ARE real options (select all refs), so that
    // branch stays before the marker; only caller-supplied refs go after it.
    const opts =
      `--author-date-order --max-count=${Math.floor(limit)}${skipArg}` +
      ` --format="${fmt}${FMT_REC_LOG}"`;
    const scope =
      normalizedRefs && normalizedRefs.length
        ? `${await this.refBarrier(...normalizedRefs)}${normalizedRefs.map(quote).join(' ')}`
        : '--branches --remotes';
    const out = await this.git(`log ${opts} ${scope}`);

    const commits: CommitInfo[] = [];
    for (const raw of out.split(RECORD_SEP)) {
      const line = raw.replace(/^\n/, '');
      if (!line.trim()) {
        continue;
      }
      const [hash, parents, authorName, authorEmail, authorDate, subject, refsStr] =
        line.split(FIELD_SEP);
      commits.push({
        hash,
        shortHash: hash.slice(0, 8),
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        authorName,
        authorEmail,
        authorDate,
        subject,
        refs: parseRefs(refsStr),
      });
    }
    return commits;
  }

  /** Ahead/behind of the current branch vs its upstream (incoming/outgoing). */
  async getTracking(): Promise<{ ahead: number; behind: number; upstream?: string }> {
    try {
      const upstream = (await this.git('rev-parse --abbrev-ref --symbolic-full-name @{u}')).trim();
      const counts = (await this.git('rev-list --left-right --count @{u}...HEAD')).trim();
      const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
      return { ahead, behind, upstream };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  /** Details + changed files for a single commit. */
  async getCommitDetail(hash: string): Promise<CommitDetail> {
    const fmt = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D'].join(FMT_FIELD_LOG);
    const out = await this.git(
      `show -s --format="${fmt}" ${await this.refBarrier(hash)}${quote(hash)}`
    );
    const [h, parents, authorName, authorEmail, authorDate, subject, refsStr] =
      out.trim().split(FIELD_SEP);

    const body = (
      await this.git(`show -s --format=%b ${await this.refBarrier(hash)}${quote(hash)}`)
    ).trim();
    const parentList = parents ? parents.split(' ').filter(Boolean) : [];

    // For commits with a parent, diff explicitly against the FIRST parent.
    // `git show --name-status` on a merge commit emits a combined diff, which
    // lists only files that differ from *all* parents — for a clean merge
    // that's nothing, so the changes pane would claim "No file changes". The
    // first-parent diff matches what the diff editor opens (hash^ vs hash).
    // A root commit has no parent, so `show` (diff vs the empty tree) is right.
    const files = await this.parseNameStatus(
      parentList.length
        ? `diff --name-status -z ${await this.refBarrier(`${h}^`, h)}${quote(`${h}^`)} ${quote(h)}`
        : `show --name-status -z --format= ${await this.refBarrier(h)}${quote(h)}`
    );

    return {
      commit: {
        hash: h,
        shortHash: h.slice(0, 8),
        parents: parentList,
        authorName,
        authorEmail,
        authorDate,
        subject,
        refs: parseRefs(refsStr),
      },
      body,
      files,
    };
  }

  /**
   * Contents of a file at a given ref (`git show <ref>:<path>`). Returns the
   * empty string when the path doesn't exist on that side (e.g. an added file's
   * "before" or a deleted file's "after"), so a diff editor can show one blank
   * pane instead of erroring.
   */
  async getFileAtRef(ref: string, path: string): Promise<string> {
    try {
      const spec = `${ref}:${path}`;
      return await this.git(`show ${await this.refBarrier(spec)}${quote(spec)}`);
    } catch {
      return '';
    }
  }

  /** Compare two refs: commits unique to each side, and the file diff. */
  async compare(base: string, target: string): Promise<CompareResult> {
    // Pass the range unquoted; getCommits quotes each ref once. The shell sees
    // 'base..target' as a single argument and git parses the `..` range itself.
    const ahead = await this.getCommits(200, [`${base}..${target}`]);
    const behind = await this.getCommits(200, [`${target}..${base}`]);
    const barrier = await this.refBarrier(base, target);
    const mergeBase = (
      await this.git(`merge-base ${barrier}${quote(base)} ${quote(target)}`)
    ).trim();
    const files = await this.parseNameStatus(
      `diff --name-status -z ${barrier}${quote(base)}...${quote(target)}`
    );
    return { ahead, behind, files, mergeBase };
  }

  /**
   * True if the working tree or index has uncommitted changes (tracked file
   * modifications, staged changes, or new untracked files). Used to guard
   * checkout/branch creation so local work isn't silently carried onto another
   * branch.
   */
  async isDirty(): Promise<boolean> {
    const out = await this.git('status --porcelain');
    return out.trim().length > 0;
  }

  // --- write operations -------------------------------------------------

  async checkout(branch: string): Promise<void> {
    // `git checkout` is the one ref-bearing command that does NOT honor
    // `--end-of-options`: its legacy branch/pathspec disambiguation ignored the
    // marker until git ~2.44, so on the still-widely-deployed 2.43.0 (Ubuntu
    // 24.04 LTS) `checkout --end-of-options <branch>` parses BOTH tokens as
    // pathspecs and dies with "did not match any file(s)". (switch, merge,
    // branch, show, diff, merge-base and log all accept the marker on 2.43.)
    // So checkout never uses the marker; like `checkout -b`, it validates the
    // ref isn't option-looking instead — git forbids ref names starting with
    // '-', so this never refuses a legitimate branch.
    assertNotOption(branch, 'branch');
    await this.git(`checkout ${quote(branch)}`);
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    // `checkout -b` consumes the token right after `-b` as the new branch name,
    // so `--end-of-options` can't be slotted in there. Validate instead: git
    // itself rejects ref names that start with '-', so this never refuses a
    // legitimate value while blocking an option-injection attempt.
    assertNotOption(name, 'branch name');
    if (startPoint !== undefined) {
      assertNotOption(startPoint, 'start point');
    }
    await this.git(`checkout -b ${quote(name)}${startPoint ? ' ' + quote(startPoint) : ''}`);
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.git(`branch ${force ? '-D' : '-d'} ${await this.refBarrier(name)}${quote(name)}`);
  }

  async merge(branch: string): Promise<void> {
    await this.git(`merge ${await this.refBarrier(branch)}${quote(branch)}`);
  }

  async fetch(): Promise<void> {
    await this.git('fetch --all --prune');
  }

  /**
   * Pull from the upstream using an explicit reconciliation strategy. Passing
   * the flag every time means a divergent branch never triggers git's "Need to
   * specify how to reconcile divergent branches" fatal — the choice is already
   * made here. Defaults to merge to match git's historical behaviour.
   */
  async pull(strategy: PullStrategy = 'merge'): Promise<void> {
    const flag =
      strategy === 'rebase' ? '--rebase' : strategy === 'ff-only' ? '--ff-only' : '--no-rebase';
    await this.git(`pull ${flag}`);
  }

  async push(): Promise<void> {
    await this.git('push');
  }

  /** Configured remote names, in git's own order (e.g. ['origin']). */
  async getRemotes(): Promise<string[]> {
    const out = await this.git('remote');
    return out.split('\n').map((r) => r.trim()).filter(Boolean);
  }

  /**
   * Push and set the upstream tracking ref in one go
   * (`git push --set-upstream <remote> <branch>`). Used to publish a new local
   * branch that has no upstream yet.
   */
  async pushSetUpstream(branch: string, remote: string): Promise<void> {
    await this.git(
      `push --set-upstream ${await this.refBarrier(remote, branch)}${quote(remote)} ${quote(branch)}`
    );
  }

  /**
   * Run a diff-family command (which must include `-z`) and parse its
   * NUL-separated name-status stream. With `-z` git never C-quotes paths, so
   * names with spaces, tabs or non-ASCII bytes arrive verbatim (the line
   * format would escape them as `"na\303\257ve.txt"` under LC_ALL=C). The
   * stream is `status NUL path NUL ...`; rename/copy records (`R###`/`C###`)
   * carry two paths, joined here as "old → new" for display and for the diff
   * opener, which splits on the arrow.
   */
  private async parseNameStatus(args: string): Promise<{ status: string; path: string }[]> {
    const out = await this.git(args);
    const tokens = out.split(FIELD_SEP);
    const files: { status: string; path: string }[] = [];
    for (let i = 0; i + 1 < tokens.length; ) {
      const status = tokens[i++];
      if (!status.trim()) {
        continue; // trailing NUL / stray newline
      }
      const path = tokens[i++];
      if (status[0] === 'R' || status[0] === 'C') {
        files.push({ status, path: `${path} → ${tokens[i++]}` });
      } else {
        files.push({ status, path });
      }
    }
    return files;
  }
}

export function parseTrack(track: string): { ahead: number; behind: number } {
  // Examples: "[ahead 2]", "[behind 3]", "[ahead 2, behind 3]", "[gone]", ""
  let ahead = 0;
  let behind = 0;
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  if (a) {
    ahead = parseInt(a[1], 10);
  }
  if (b) {
    behind = parseInt(b[1], 10);
  }
  return { ahead, behind };
}

export function parseRefs(refsStr: string): string[] {
  if (!refsStr) {
    return [];
  }
  return refsStr
    .split(',')
    .map((r) => r.trim().replace(/^HEAD -> /, ''))
    .filter((r) => r && !r.startsWith('tag: '));
}

/** Quote a git argument so branch names with odd characters survive the shell. */
export function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Older persisted focus values, or extension/webview boundary values from a
 * previous build, may already be shell-quoted. If passed through `quote` again,
 * git receives literal quote bytes and errors with "ambiguous argument
 * ''main''". Only unwrap a complete POSIX single-quoted shell word; every other
 * ref is left byte-for-byte intact.
 */
export function normalizeRefArgument(ref: string): string {
  if (!/^'(?:[^']|'\\'')*'$/.test(ref)) {
    return ref;
  }
  return ref.slice(1, -1).replace(/'\\''/g, "'");
}

/**
 * Reject a value that git would parse as an option (leading '-'). Used only for
 * the spots where `--end-of-options` can't mark the option/positional boundary
 * — chiefly `checkout -b <name>`, where the token after `-b` is consumed as the
 * new branch name. git itself forbids ref names beginning with '-', so a
 * legitimate branch name or start point is never rejected; this purely blocks an
 * argument-injection attempt. Shell-quoting can't help here: a quoted
 * `'--upload-pack=…'` still reaches git as a single dash-led argument.
 */
export function assertNotOption(arg: string, label = 'argument'): void {
  if (arg.startsWith('-')) {
    throw new Error(`Refusing unsafe ${label}: must not begin with "-" (got "${arg}").`);
  }
}
