/**
 * Paging behavior of the native Commits tree: tree views get no scroll
 * events, so more history is paged in through a trailing "Load more commits…"
 * row (`loadMore` node) driven by setCommits/appendCommits/setLoadingMore.
 */
import { describe, expect, it } from 'vitest';
import { CommitsProvider, CommitTreeNode, escapeMarkdown } from './commitsProvider';
import type { CommitInfo } from '../git/gitService';

const commit = (hash: string): CommitInfo => ({
  hash,
  shortHash: hash.slice(0, 8),
  parents: [],
  authorName: 'Ada Lovelace',
  authorEmail: 'ada@example.com',
  authorDate: '2026-01-01T00:00:00+00:00',
  subject: `Subject ${hash}`,
  refs: [],
});

const provider = () => new CommitsProvider(async () => []);

const rootHashes = (nodes: CommitTreeNode[]) =>
  nodes.map((n) => (n.kind === 'commit' ? n.info.hash : n.kind));

describe('CommitsProvider paging', () => {
  it('appends a Load more row only while more history exists', async () => {
    const p = provider();
    p.setCommits([commit('a'), commit('b')], true);
    expect(rootHashes(await p.getChildren())).toEqual(['a', 'b', 'loadMore']);

    p.setCommits([commit('a')], false);
    expect(rootHashes(await p.getChildren())).toEqual(['a']);
  });

  it('the Load more row triggers the native loadMore command', async () => {
    const p = provider();
    p.setCommits([commit('a')], true);
    const [, loadMore] = await p.getChildren();
    const item = p.getTreeItem(loadMore);
    expect(item.label).toBe('Load more commits…');
    expect(item.command?.command).toBe('gitBranchView.native.loadMore');
  });

  it('disables the row while a page is in flight, re-enabling on arrival', async () => {
    const p = provider();
    p.setCommits([commit('a')], true);
    p.setLoadingMore();
    const [, loadMore] = await p.getChildren();
    expect(p.getTreeItem(loadMore).label).toBe('Loading more commits…');
    expect(p.getTreeItem(loadMore).command).toBeUndefined();

    p.appendCommits([commit('b')], true);
    expect(rootHashes(await p.getChildren())).toEqual(['a', 'b', 'loadMore']);
    expect(p.getTreeItem({ kind: 'loadMore' }).command).toBeDefined();
  });

  it('appendCommits drops the row when the history is exhausted', async () => {
    const p = provider();
    p.setCommits([commit('a')], true);
    p.appendCommits([commit('b')], false);
    expect(rootHashes(await p.getChildren())).toEqual(['a', 'b']);
  });

  it('compare mode shows the comparison sections, never a Load more row', async () => {
    const p = provider();
    p.setCommits([commit('a')], true);
    p.setCompare('main', 'dev', {
      ahead: [commit('x')],
      behind: [],
      files: [],
      mergeBase: 'mb',
    });
    const roots = await p.getChildren();
    expect(roots.every((n) => n.kind === 'section')).toBe(true);

    // The next setCommits returns to (paged) branch history.
    p.setCommits([commit('a')], true);
    expect(rootHashes(await p.getChildren())).toEqual(['a', 'loadMore']);
  });
});

describe('escapeMarkdown', () => {
  it('neutralizes markdown link/image/code/html metacharacters', () => {
    expect(escapeMarkdown('[click](http://evil)')).toBe('\\[click\\]\\(http://evil\\)');
    expect(escapeMarkdown('![img](http://evil/x.png)')).toBe(
      '\\!\\[img\\]\\(http://evil/x.png\\)'
    );
    expect(escapeMarkdown('a`b`c')).toBe('a\\`b\\`c');
    expect(escapeMarkdown('<script>')).toBe('\\<script\\>');
    expect(escapeMarkdown('plain text')).toBe('plain text');
  });
});

describe('CommitsProvider commit tooltip', () => {
  /** A commit whose metadata tries to smuggle a markdown image/link. */
  const evil = (): CommitInfo => ({
    hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    shortHash: 'deadbeef',
    parents: [],
    authorName: '[Ada](http://evil)',
    authorEmail: 'ada@example.com',
    authorDate: '2026-01-01T00:00:00+00:00',
    subject: '![pwn](http://evil/track.png)',
    refs: [],
  });

  it('escapes untrusted commit metadata so it cannot inject a link or image', () => {
    const p = provider();
    const item = p.getTreeItem({ kind: 'commit', info: evil() });
    // The mock MarkdownString concatenates appended fragments into `.value`.
    const value = (item.tooltip as { value: string }).value;
    // No raw markdown image/link syntax survives — the brackets/parens are escaped.
    expect(value).not.toContain('![pwn](');
    expect(value).not.toContain('[Ada](');
    expect(value).toContain('\\!\\[pwn\\]\\(http://evil/track.png\\)');
    expect(value).toContain('\\[Ada\\]\\(http://evil\\)');
  });
});
