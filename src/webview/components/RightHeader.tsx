import React from 'react';
import { post } from '../vscodeApi';
import type { Tracking } from '../types';
import { displayRefName } from '../format';

interface RightHeaderProps {
  branchName: string;
  tracking: Tracking;
  /** Active comparison; replaces the branch title while set. */
  compare: { base: string; target: string } | null;
}

/** Incoming/outgoing summary with the fetch/pull/push/sync quick links. */
export function RightHeader({ branchName, tracking, compare }: RightHeaderProps) {
  const t = tracking || { ahead: 0, behind: 0 };
  const sync = () => {
    post({ type: 'pull' });
    post({ type: 'push' });
  };
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
        <a onClick={() => post({ type: 'pull' })}>Pull</a>
      </div>
      <div className="section">
        <span className="title">Local History ({t.ahead} Outgoing)</span>
        <a onClick={() => post({ type: 'push' })}>Push</a>
        <span>|</span>
        <a onClick={sync}>Sync</a>
      </div>
    </div>
  );
}
