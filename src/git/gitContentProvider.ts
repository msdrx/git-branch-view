import * as vscode from 'vscode';
import { GitService } from './gitService';

/** URI scheme under which file-at-a-ref contents are served to diff editors. */
export const BRANCH_VIEW_SCHEME = 'gitbranchview';

/**
 * Serves a file's contents at a specific git ref so the native UI can open real
 * diff editors (commit vs. parent, base vs. target). URIs look like:
 *
 *   gitbranchview:/<repo-relative-path>?ref=<ref>&root=<repoRoot>
 *
 * The ref and repo root travel in the query so the provider is stateless — it
 * builds a throwaway `GitService` per request. A missing path on one side (an
 * added file's "before", a deleted file's "after") resolves to '' via
 * `getFileAtRef`, so the diff shows one blank pane instead of erroring.
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const ref = params.get('ref');
    const root = params.get('root');
    const path = uri.path.replace(/^\//, '');
    if (!ref || !root || !path) {
      return '';
    }
    return new GitService(root).getFileAtRef(ref, path);
  }
}

/**
 * Diff-tab label for a ref: hashes abbreviate to 8 chars, branch names (used
 * when a comparison's file is opened) stay whole.
 */
export function refLabel(ref: string): string {
  return /^[0-9a-f]{12,40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

/** Build a `gitbranchview:` URI addressing <path> at <ref> within <root>. */
export function fileAtRefUri(root: string, ref: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BRANCH_VIEW_SCHEME,
    path: '/' + path,
    query: new URLSearchParams({ ref, root }).toString(),
  });
}
