import React from 'react';
import { post } from '../vscodeApi';
import type { Tracking } from '../types';
import { displayRefName } from '../format';

interface RightHeaderProps {
  branchName: string;
  tracking: Tracking;
  /** Active comparison; replaces the branch title while set. */
  compare: { base: string; target: string } | null;
  /**
   * Whether the viewed branch is the checked-out one. `git pull`/`push` act on
   * HEAD, so when viewing another branch (or a comparison) those actions would
   * mutate a branch other than the one whose counts are shown — we disable them
   * to keep the header self-consistent. Fetch stays enabled (it's repo-global).
   */
  isCurrentBranch: boolean;
}

/** Incoming/outgoing summary with the fetch/pull/push/sync quick links. */
export function RightHeader({ branchName, tracking, compare, isCurrentBranch }: RightHeaderProps) {
  const t = tracking || { ahead: 0, behind: 0 };
  const sync = () => {
    post({ type: 'pull' });
    post({ type: 'push' });
  };
  // Pull/push/sync apply to HEAD; disable them when HEAD isn't what's shown.
  const disabledTitle =
    'Pull, push and sync act on the checked-out branch. Check out this branch to sync it.';
  const branchAction = (label: string, onClick: () => void) =>
    isCurrentBranch ? (
      <a onClick={onClick}>{label}</a>
    ) : (
      <span className="disabled" title={disabledTitle} aria-disabled="true">
        {label}
      </span>
    );
  return (
    <div id="rightHeader">
      <div className="section">
        <span className="title">
          {compare ? (
            <>
              Compare: {displayRefName(compare.base)} ⇄ {displayRefName(compare.target)}
            </>
          ) : (
            <>Branch: {branchName || '(none)'}</>
          )}
        </span>
      </div>
      <div className="section">
        <span className="title">Incoming ({t.behind})</span>
        <a onClick={() => post({ type: 'fetch' })}>Fetch</a>
        <span>|</span>
        {branchAction('Pull', () => post({ type: 'pull' }))}
      </div>
      <div className="section">
        <span className="title">Local History ({t.ahead} Outgoing)</span>
        {branchAction('Push', () => post({ type: 'push' }))}
        <span>|</span>
        {branchAction('Sync', sync)}
      </div>
    </div>
  );
}
