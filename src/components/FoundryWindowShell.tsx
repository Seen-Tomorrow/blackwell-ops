import type { ReactNode } from "react";

export type FoundryWindowTone = "amber" | "green" | "red";
export type FoundryWindowVariant = "confirm" | "build" | "compact";

interface FoundryWindowShellProps {
  title: ReactNode;
  tone?: FoundryWindowTone;
  variant?: FoundryWindowVariant;
  onMinimize?: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export default function FoundryWindowShell({
  title,
  tone = "amber",
  variant = "build",
  onMinimize,
  headerExtra,
  children,
  footer,
}: FoundryWindowShellProps) {
  return (
    <div className={`foundry-window foundry-window--${variant}`}>
      <div className="foundry-window__chrome">
        <div className={`foundry-window__header foundry-window__header--${tone}`}>
          <div className="foundry-window__header-main">
            <span className="foundry-window__title">{title}</span>
            {headerExtra}
          </div>
          {onMinimize && (
            <button
              type="button"
              className="foundry-window__minimize"
              onClick={onMinimize}
              title="Minimize to status bar"
            >
              ─
            </button>
          )}
        </div>
        <div className="foundry-window__body">{children}</div>
        {footer ? <div className="foundry-window__footer">{footer}</div> : null}
      </div>
    </div>
  );
}