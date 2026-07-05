import type { ReactNode } from 'react';

const SIDE_CLASS: Record<'left' | 'right', string> = {
  left: 'left-4',
  right: 'right-4',
};

interface PanelRailProps {
  side: 'left' | 'right';
  children: ReactNode;
}

/** One docked, scrollable glass surface per side of the viewport. Every panel that used
 * to be independently `fixed`-positioned on that side is now a child section inside this
 * ONE flex column — height/position is resolved by real CSS flow, not a hardcoded
 * left-offset guessing a sibling's rendered width (the bug this replaces: `left-[28rem]`
 * and `left-[34rem]` genuinely overlapped because neither accounted for the other). */
export function PanelRail({ side, children }: PanelRailProps) {
  return (
    <div
      className={`fixed top-32 z-40 flex max-h-[calc(100vh-9rem)] w-72 flex-col gap-2 overflow-y-auto rounded-box border border-white/5 bg-base-100/85 p-2 shadow-2xl backdrop-blur-md ${SIDE_CLASS[side]}`}
    >
      {children}
    </div>
  );
}
