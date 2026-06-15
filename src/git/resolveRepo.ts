import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, Logger } from './gitService';

/** True when `child` is the same path as, or nested inside, `parent`. */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when `filePath` lives inside one of the open workspace folders. */
function isInsideWorkspaceFolders(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((f) => isPathInside(filePath, f.uri.fsPath));
}

/**
 * The git repository root of the active editor's file — but ONLY when that file
 * is a real file living inside the workspace. Returns `undefined` when there's
 * no active file editor, the file lives outside every workspace folder (so an
 * unrelated repo can never hijack the view), or the file isn't in a git repo.
 */
export async function activeEditorRepoRoot(logger?: Logger): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (!active || active.scheme !== 'file' || !isInsideWorkspaceFolders(active.fsPath)) {
    return undefined;
  }
  return GitService.findRepoRoot(path.dirname(active.fsPath), logger);
}

/**
 * Pick the repository root the branch view should operate on. Shared by both
 * front-ends (webview panel + native trees) so they always resolve the SAME
 * repo.
 *
 * In a multi-root workspace it prefers the repository containing the active
 * editor's file — so the view follows what the user is actually looking at —
 * but only when that file is inside the workspace (see `activeEditorRepoRoot`).
 * Otherwise it falls back to the first workspace folder that resolves to a git
 * repository. (A single-root workspace skips the active-editor probe: the one
 * folder is the answer, and an editor pointing somewhere outside it shouldn't
 * silently retarget the view.)
 *
 * Returns `undefined` when no workspace folder resolves to a git repository.
 * Callers cache the result and re-invoke when the workspace folders change or
 * the active editor moves to another in-workspace repo.
 */
export async function resolveRepoRoot(logger?: Logger): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  // Multi-root: follow the file the user is editing, when it lives in a repo
  // inside the workspace.
  if (folders.length > 1) {
    const active = await activeEditorRepoRoot(logger);
    if (active) {
      return active;
    }
  }

  for (const f of folders) {
    const root = await GitService.findRepoRoot(f.uri.fsPath, logger);
    if (root) {
      return root;
    }
  }
  return undefined;
}
