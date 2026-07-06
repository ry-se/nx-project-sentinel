import type { ReactNode } from 'react';

export interface PanelSectionProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** Declarative section metadata consumed by `PanelRail` when it renders a tabbed rail. */
export function PanelSection({ children }: PanelSectionProps) {
  return <>{children}</>;
}
