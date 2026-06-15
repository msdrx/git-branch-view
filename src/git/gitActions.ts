import * as vscode from 'vscode';
import { GitService, PullStrategy } from './gitService';

/**
 * VS Code-coupled git operations shared by both front-ends (the webview panel
 * and the native tree UI), so the two behave identically: the same dirty-tree
 * guard, the same push recovery flows, and the same pull-strategy plumbing.
 *
 * `gitService.ts` stays free of any `vscode` import (pure CLI wrapper); the
 * interactive bits — modal warnings, input boxes, config reads — live here.
 */

export const PULL_STRATEGIES: readonly PullStrategy[] = ['merge', 'rebase', 'ff-only'];

/** How commit dates render in the Date column (`gitBranchView.dateFormat`). */
export type DateFormatPref = 'relative' | 'iso' | 'local';

const DATE_FORMATS: readonly DateFormatPref[] = ['relative', 'iso', 'local'];

/** The persisted date format, falling back to the local format. */
export function getDateFormat(): DateFormatPref {
  const value = vscode.workspace
    .getConfiguration('gitBranchView')
    .get<string>('dateFormat', 'local');
  return (DATE_FORMATS as readonly string[]).includes(value)
    ? (value as DateFormatPref)
    : 'local';
}

/** Human labels for the pull strategies, keyed by the stored config value. */
export const PULL_STRATEGY_LABELS: Record<PullStrategy, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'ff-only': 'Fast-forward only',
};

/** The persisted pull strategy, falling back to merge (git's historical default). */
export function getPullStrategy(): PullStrategy {
  const value = vscode.workspace
    .getConfiguration('gitBranchView')
    .get<string>('pullStrategy', 'merge');
  return (PULL_STRATEGIES as readonly string[]).includes(value)
    ? (value as PullStrategy)
    : 'merge';
}

/**
 * Persist a chosen pull strategy globally (validated), so it becomes the default
 * for all future pulls in every repo. Returns the value actually written.
 */
export async function setPullStrategy(strategy: string): Promise<PullStrategy> {
  const next: PullStrategy = (PULL_STRATEGIES as readonly string[]).includes(strategy)
    ? (strategy as PullStrategy)
    : 'merge';
  await vscode.workspace
    .getConfiguration('gitBranchView')
    .update('pullStrategy', next, vscode.ConfigurationTarget.Global);
  return next;
}

/**
 * Guard a working-tree-mutating action behind the dirty check. Returns true when
 * the tree is clean and the caller may proceed; when dirty, shows a modal warning
 * (with an "Open Source Control" escape hatch) and returns false so local work is
 * never silently carried onto another branch.
 */
export async function ensureClean(git: GitService, message: string): Promise<boolean> {
  if (!(await git.isDirty())) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    'Open Source Control'
  );
  if (choice === 'Open Source Control') {
    await vscode.commands.executeCommand('workbench.view.scm');
  }
  return false;
}

/**
 * Push the current branch, with friendly recovery for the two common failures
 * instead of a raw error:
 *  - "has no upstream branch" (a brand-new local branch) → offer to publish it
 *    with `--set-upstream` so it tracks <remote>/<branch> (matching name).
 *  - non-fast-forward rejection ("fetch first") — the remote has commits we don't
 *    have locally → offer to pull them before pushing again.
 * Any other failure is rethrown for the caller to surface. `onChange` runs after
 * each step that mutates state so the calling UI can refresh.
 */
export async function pushWithRecovery(
  git: GitService,
  onChange: () => void | Promise<void>
): Promise<void> {
  try {
    await git.push();
    await onChange();
  } catch (err) {
    if (/no upstream branch/i.test(String(err))) {
      await publishBranch(git, err, onChange);
      return;
    }
    if (isNonFastForward(String(err))) {
      await pullThenPush(git, onChange);
      return;
    }
    throw err;
  }
}

/** Publish a branch that has no upstream yet (`push --set-upstream`). */
async function publishBranch(
  git: GitService,
  err: unknown,
  onChange: () => void | Promise<void>
): Promise<void> {
  const branch = await git.getCurrentBranch();
  const remotes = await git.getRemotes();
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!branch || !remote) {
    throw err;
  }
  const choice = await vscode.window.showInformationMessage(
    `Branch "${branch}" has no upstream branch. ` +
      `Publish it and set "${remote}/${branch}" as its upstream?`,
    { modal: true },
    'Publish Branch'
  );
  if (choice === 'Publish Branch') {
    await git.pushSetUpstream(branch, remote);
    vscode.window.showInformationMessage(`Published ${branch} to ${remote}/${branch}`);
    await onChange();
  }
}

/**
 * Recover from a rejected (non-fast-forward) push: the remote has commits the
 * local branch lacks, so the push must be preceded by a pull. Offer to pull the
 * remote changes, then re-push so the user's commits still reach the remote in
 * one action.
 */
async function pullThenPush(
  git: GitService,
  onChange: () => void | Promise<void>
): Promise<void> {
  const branch = await git.getCurrentBranch();
  const choice = await vscode.window.showWarningMessage(
    `Can't push "${branch}": the remote has commits you don't have locally. ` +
      `Pull the remote changes first, then push again.`,
    { modal: true },
    'Pull and Push',
    'Pull'
  );
  if (choice !== 'Pull' && choice !== 'Pull and Push') {
    return;
  }
  await git.pull(getPullStrategy());
  await onChange();
  if (choice === 'Pull and Push') {
    await git.push();
    vscode.window.showInformationMessage(`Pushed ${branch}`);
    await onChange();
  }
}

/**
 * True if a `git push` failure is a non-fast-forward rejection — the remote ref
 * has advanced past the local branch ("Updates were rejected because the remote
 * contains work that you do not have locally", hinting "fetch first"). Matched
 * loosely against git's stderr since the exact wording varies by version.
 */
export function isNonFastForward(text: string): boolean {
  return /\[rejected\]|fetch first|non-fast-forward|failed to push some refs/i.test(text);
}
