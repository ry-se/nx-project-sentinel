import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';

interface PanelSectionProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** One collapsible section inside a `PanelRail` — replaces what used to be an
 * independently `fixed`-positioned panel. Defaults to expanded, matching every existing
 * panel's always-visible behavior today (zero test risk from the default state). */
export function PanelSection({ title, actions, children }: PanelSectionProps) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 pt-1">
        <button
          type="button"
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-base-content/40"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {title}
        </button>
        {actions}
      </div>
      {open && <div className="flex flex-col gap-1">{children}</div>}
    </div>
  );
}
