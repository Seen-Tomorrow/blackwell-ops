import type { ReactNode } from "react";

export type FoundryWindowTone = "amber" | "green" | "red";
type FoundryWindowVariant = "confirm" | "build" | "compact";

interface FoundryWindowShellProps {
  title: ReactNode;
  tone?: FoundryWindowTone;
  variant?: FoundryWindowVariant;
  /**
   * Size the window to its content instead of the variant's fixed height. The build
   * variant reserves 82vh for the terminal; with the log drawer shut that space is
   * just an empty panel, so the shell shrinks to the instrument strip.
   */
  autoHeight?: boolean;
  onMinimize?: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export default function FoundryWindowShell({
  title,
  tone = "amber",
  variant = "build",
  autoHeight = false,
  onMinimize,
  headerExtra,
  children,
  footer,
}: FoundryWindowShellProps) {
  return (
    <div
      className={`foundry-window foundry-window--${variant}${
        autoHeight ? " foundry-window--auto-height" : ""
      }`}
    >
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