/**
 * Side-by-side or stacked dual fusion panes.
 * Primary keeps share/bench ownership; secondary is metrics-only chrome.
 */

import type { FusionDualOrient } from "../lib/storage";
import FusionPane, { type FusionPaneProps } from "./FusionPane";

export type FusionPaneIdentity = Omit<FusionPaneProps, "active" | "secondary" | "className">;

export interface FusionDualStageProps {
  orient: FusionDualOrient;
  primary: FusionPaneIdentity;
  secondary: FusionPaneIdentity;
}

export default function FusionDualStage({
  orient,
  primary,
  secondary,
}: FusionDualStageProps) {
  return (
    <div
      className={`fusion-dual-stage fusion-dual-stage--${orient} flex min-h-0 min-w-0 flex-1 w-full overflow-hidden`}
      data-fusion-dual={orient}
    >
      <div className="fusion-dual-stage__pane fusion-dual-stage__pane--primary min-h-0 min-w-0 flex flex-col overflow-hidden">
        <FusionPane {...primary} active secondary={false} />
      </div>
      <div
        className="fusion-dual-stage__divider"
        aria-hidden
      />
      <div className="fusion-dual-stage__pane fusion-dual-stage__pane--secondary min-h-0 min-w-0 flex flex-col overflow-hidden">
        <FusionPane {...secondary} active secondary />
      </div>
    </div>
  );
}
