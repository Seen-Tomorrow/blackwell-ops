import type { ReactNode } from "react";
import { ToastAnchor } from "./Toast";
import HeaderDownloadStrip from "./HeaderDownloadStrip";

interface TabPageHeaderProps {
  title: string;
  showIcon?: boolean;
  meta?: ReactNode;
  actions?: ReactNode;
}

export default function TabPageHeader({ title, showIcon = true, meta, actions }: TabPageHeaderProps) {
  return (
    <div className="tab-page-header px-4 py-1 border-b border-stealth-border/50 flex items-center gap-3 min-w-0 flex-shrink-0">
      <div className="flex items-center gap-3 shrink-0 min-w-0">
        <h2 className="text-xs font-mono theme-accent-text tracking-widest whitespace-nowrap">
          {showIcon ? `✦ ${title}` : title}
        </h2>
        {meta}
        {actions}
      </div>
      <ToastAnchor className="tab-page-header__toast-anchor" />
      {/* Far-right: full inline download row (name + bar + actions, no clip) */}
      <HeaderDownloadStrip />
    </div>
  );
}