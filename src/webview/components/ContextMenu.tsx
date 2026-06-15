import React, { useLayoutEffect, useRef, useState } from 'react';
import type { MenuState } from '../state';
import { post } from '../vscodeApi';
import { branchDisplayName } from '../format';
import { PULL_STRATEGY_LABELS, type PullStrategy } from '../types';

export interface MenuItem {
  label: string;
  icon?: string;
  disabled?: boolean;
  act?(): void;
  sep?: boolean;
}

interface ContextMenuProps {
  menu: MenuState | null;
  current: string;
  pullStrategy: PullStrategy;
  onClose(): void;
  onCompareFrom(base: string): void;
}

/** Build the menu items for whatever the menu was opened on. */
export function buildMenuItems(
  menu: MenuState,
  ctx: { current: string; pullStrategy: PullStrategy; onCompareFrom(base: string): void }
): MenuItem[] {
  const t = menu.target;
  switch (t.type) {
    case 'branch': {
      const b = t.branch;
      return [
        {
          label: `Checkout ${branchDisplayName(b)}`,
          icon: '✔',
          act: () => post({ type: 'checkout', branch: b.refName }),
          disabled: b.isHead,
        },
        { sep: true, label: '' },
        { label: 'New Branch…', icon: '🜉', act: () => post({ type: 'createBranch', startPoint: b.refName }) },
        { sep: true, label: '' },
        {
          label: `Merge into ${ctx.current}`,
          icon: '⇄',
          act: () => post({ type: 'merge', branch: b.refName }),
          disabled: b.isHead,
        },
        { label: 'Compare with…', icon: '⇄', act: () => ctx.onCompareFrom(b.refName) },
        { sep: true, label: '' },
        {
          label: 'Delete',
          icon: '🗑',
          act: () => post({ type: 'deleteBranch', branch: b.refName }),
          disabled: b.isHead || b.kind !== 'local',
        },
      ];
    }
    case 'commit': {
      const c = t.commit;
      return [
        { label: 'View Commit Details', icon: 'ℹ', act: () => post({ type: 'commitDetail', hash: c.hash }) },
        { sep: true, label: '' },
        { label: 'New Branch…', icon: '🜉', act: () => post({ type: 'createBranch', startPoint: c.hash }) },
        { sep: true, label: '' },
        { label: 'Checkout (--detach)', icon: '✔', act: () => post({ type: 'checkout', branch: c.hash }) },
        { label: 'Copy Commit ID', icon: '⧉', act: () => void navigator.clipboard?.writeText(c.hash) },
      ];
    }
    case 'pullStrategy':
      return (Object.keys(PULL_STRATEGY_LABELS) as PullStrategy[]).map((key) => ({
        label: PULL_STRATEGY_LABELS[key],
        icon: ctx.pullStrategy === key ? '✓' : '',
        act: () => post({ type: 'setPullStrategy', strategy: key }),
      }));
  }
}

/**
 * The single context menu. Always present in the DOM (`#contextMenu`, hidden
 * via the `.hidden` class) so external tooling can key off it, matching the
 * original implementation.
 */
export function ContextMenu({ menu, current, pullStrategy, onClose, onCompareFrom }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // Clamp to the viewport once the menu has a measurable size.
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      return;
    }
    const el = ref.current;
    setPos({
      x: Math.min(menu.x, window.innerWidth - el.offsetWidth - 8),
      y: Math.min(menu.y, window.innerHeight - el.offsetHeight - 8),
    });
  }, [menu]);

  const items = menu ? buildMenuItems(menu, { current, pullStrategy, onCompareFrom }) : [];

  return (
    <div
      id="contextMenu"
      ref={ref}
      className={`context-menu${menu ? '' : ' hidden'}`}
      style={menu ? { left: pos.x, top: pos.y } : undefined}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div className="sep" key={i} />
        ) : (
          <div
            className={`item${it.disabled ? ' disabled' : ''}`}
            key={i}
            onClick={() => {
              onClose();
              if (!it.disabled) {
                it.act?.();
              }
            }}
          >
            <span className="icon">{it.icon || ''}</span>
            <span>{it.label}</span>
          </div>
        )
      )}
    </div>
  );
}
