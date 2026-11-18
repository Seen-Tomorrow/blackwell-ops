import { describe, expect, it } from "vitest";
import {
  buildThinkOptions,
  resolveFullAutoPlan,
  thinkLabelFor,
  type SpeedBoostId,
} from "./multiAgentBooster";

/**
 * The Think ladder is a token-budget control: the template keeps the machine names
 * (`off` / `on` / budgets, because they key its CLI sub_params) and the cockpit only
 * relabels the two sentinels. A budget must keep its own number — that number IS the
 * budget the user is setting — and the rung is written back verbatim.
 */
const base = {
  codingMode: "solo",
  speed: "off" as SpeedBoostId,
  brains: "solid",
  capabilities: [] as ("mtp" | "dflash" | "eagle3")[],
  dflashLibraryReady: false,
  kvQuantValues: ["q8_0"],
  powerUser: true,
};

describe("Think marks", () => {
  it("only relabels the two sentinel rungs; a budget keeps its own name", () => {
    expect(thinkLabelFor("2000")).toBe("2000");
    expect(thinkLabelFor("8000")).toBe("8000");
    // Sentinels read as words, not as the stored value.
    expect(thinkLabelFor("off")).not.toBe("off");
    expect(thinkLabelFor("on")).not.toBe("on");
  });

  it("orders the ladder off → budgets ascending → no-limit, whatever the template order", () => {
    const ids = buildThinkOptions(["on", "off", 8000, 2000, 4000]).map((o) => o.id);

    expect(ids).toEqual(["off", "2000", "4000", "8000", "on"]);
  });

  it("keeps a budget we have no note for instead of dropping it", () => {
    expect(buildThinkOptions(["off", 32000]).map((o) => o.id)).toEqual([
      "off",
      "32000",
    ]);
  });

  it("writes the stored value back verbatim so the template owns the CLI flags", () => {
    expect(resolveFullAutoPlan({ ...base, think: "on" }).reasoning).toBe("on");
    expect(resolveFullAutoPlan({ ...base, think: "8000" }).reasoning).toBe("8000");
    expect(resolveFullAutoPlan({ ...base, think: "off" }).reasoning).toBe("off");
  });
});
