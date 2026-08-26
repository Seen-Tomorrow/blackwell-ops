/**
 * Side-by-side or stacked dual fusion panes.
 * Each pane owns share/bench for its engine; secondary is layout order only.
 * Visual order follows RUNNING ENGINES / eject (lower stack idx first:
 * left in side, top in stack) — not catalog selection.
 */

import type { FusionDualOrient } from "../lib/storage";
import { dualPrimaryPaintsFirst } from "../hooks/useFusionDisplayMode";
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
  const primaryFirst = dualPrimaryPaintsFirst(primary.slotIdx, secondary.slotIdx);
  const first = primaryFirst ? primary : secondary;
  const second = primaryFirst ? secondary : primary;

  return (
    <div
      className={`fusion-dual-stage fusion-dual-stage--${orient} flex min-h-0 min-w-0 flex-1 w-full overflow-hidden`}
      data-fusion-dual={orient}
      data-fusion-dual-order={primaryFirst ? "primary-first" : "secondary-first"}
    >
      <div className="fusion-dual-stage__pane fusion-dual-stage__pane--first min-h-0 min-w-0 flex flex-col overflow-hidden">
        <FusionPane {...first} active secondary={!primaryFirst} />
      </div>
      <div
        className="fusion-dual-stage__divider"
        aria-hidden
      />
      <div className="fusion-dual-stage__pane fusion-dual-stage__pane--second min-h-0 min-w-0 flex flex-col overflow-hidden">
        <FusionPane {...second} active secondary={primaryFirst} />
      </div>
    </div>
  );
}
