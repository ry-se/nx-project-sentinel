import {
  Children,
  isValidElement,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { PanelSection, type PanelSectionProps } from './PanelSection';

const SIDE_CLASS: Record<'left' | 'right', string> = {
  left: 'left-4',
  right: 'right-4',
};

const RAIL_CLASS =
  'fixed top-18 z-40 flex max-h-[calc(100vh-9rem)] w-72 flex-col rounded-box border border-white/5 bg-base-100/85 p-3 shadow-2xl backdrop-blur-md';

interface PanelRailProps {
  side: 'left' | 'right';
  children: ReactNode;
}

interface RailSection {
  key: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

function isPanelSectionElement(child: ReactNode): child is ReactElement<PanelSectionProps> {
  return isValidElement<PanelSectionProps>(child) && child.type === PanelSection;
}

function getRailSections(children: ReactNode): RailSection[] | null {
  const childArray = Children.toArray(children);
  if (childArray.length === 0 || !childArray.every(isPanelSectionElement)) {
    return null;
  }

  return childArray.map((child, index) => ({
    key: String(child.key ?? `section-${index}`),
    title: child.props.title,
    actions: child.props.actions,
    children: child.props.children,
  }));
}

/** One docked, scrollable glass surface per side of the viewport. Every panel that used
 * to be independently `fixed`-positioned on that side is now a child section inside this
 * ONE flex column — height/position is resolved by real CSS flow, not a hardcoded
 * left-offset guessing a sibling's rendered width (the bug this replaces: `left-[28rem]`
 * and `left-[34rem]` genuinely overlapped because neither accounted for the other). */
export function PanelRail({ side, children }: PanelRailProps) {
  const railId = useId();
  const sections = getRailSections(children);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  if (!sections) {
    return (
      <div className={`${RAIL_CLASS} gap-2 overflow-x-hidden overflow-y-auto ${SIDE_CLASS[side]}`}>
        {children}
      </div>
    );
  }

  const activeIndex = sections.findIndex((section) => section.key === activeKey);
  const selectedIndex = activeIndex >= 0 ? activeIndex : 0;
  return (
    <div className={`${RAIL_CLASS} gap-3 overflow-hidden ${SIDE_CLASS[side]}`}>
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="grid shrink-0 gap-1 border-b border-white/10 pb-2"
        style={{ gridTemplateColumns: `repeat(${sections.length}, minmax(0, 1fr))` }}
      >
        {sections.map((section, index) => {
          const selected = index === selectedIndex;
          const tabId = `${railId}-tab-${index}`;
          const panelId = `${railId}-panel-${index}`;
          return (
            <button
              key={section.key}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              className={`btn btn-xs h-7 min-w-0 px-1 font-normal ${
                selected ? 'btn-primary' : 'btn-ghost text-base-content/60'
              }`}
              onClick={() => setActiveKey(section.key)}
              title={section.title}
            >
              <span className="truncate">{section.title}</span>
            </button>
          );
        })}
      </div>

      {sections.map((section, index) => {
        const selected = index === selectedIndex;
        return (
          <div
            key={section.key}
            id={`${railId}-panel-${index}`}
            role="tabpanel"
            aria-labelledby={`${railId}-tab-${index}`}
            hidden={!selected}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {section.actions && (
              <div className="mb-2 flex justify-end px-1">{section.actions}</div>
            )}
            <div className="flex flex-col gap-1">{section.children}</div>
          </div>
        );
      })}
    </div>
  );
}
