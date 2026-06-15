import React from 'react';
import { post } from '../vscodeApi';
import { PULL_STRATEGY_LABELS, type PullStrategy } from '../types';
import { displayRefName } from '../format';

interface ToolbarProps {
  compareBase: string | null;
  pullStrategy: PullStrategy;
  onToggleCompare(): void;
  onPullStrategyMenu(e: React.MouseEvent): void;
}

interface TbButtonProps {
  label: string;
  icon: string;
  title?: string;
  className?: string;
  onClick(e: React.MouseEvent): void;
}

function TbButton({ label, icon, title, className, onClick }: TbButtonProps) {
  return (
    <button className={`tb-btn${className ? ` ${className}` : ''}`} title={title || label} onClick={onClick}>
      <span className="icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

const Sep = () => <span className="tb-sep" />;

export function Toolbar({ compareBase, pullStrategy, onToggleCompare, onPullStrategyMenu }: ToolbarProps) {
  const strategyLabel = PULL_STRATEGY_LABELS[pullStrategy] || 'Merge';
  return (
    <div id="toolbar">
      <TbButton label="Refresh" icon="⟳" onClick={() => post({ type: 'ready', reset: true })} />
      <Sep />
      <TbButton label="Fetch" icon="↓" onClick={() => post({ type: 'fetch' })} />
      {/* Pull split-button: the main button pulls with the active strategy; the
          caret opens a menu to pick which strategy future pulls use. */}
      <TbButton label="Pull" icon="⤓" title={`Pull (${strategyLabel})`} onClick={() => post({ type: 'pull' })} />
      <TbButton
        label=""
        icon="▾"
        className="tb-caret"
        title={`Pull strategy: ${strategyLabel}`}
        onClick={onPullStrategyMenu}
      />
      <TbButton label="Push" icon="↑" onClick={() => post({ type: 'push' })} />
      <Sep />
      <TbButton label="New Branch" icon="＋" onClick={() => post({ type: 'createBranch' })} />
      <TbButton
        label={compareBase ? `Comparing: ${displayRefName(compareBase)} ✕` : 'Compare'}
        icon="⇄"
        title="Pick a base branch, then click another branch to compare"
        onClick={onToggleCompare}
      />
    </div>
  );
}
