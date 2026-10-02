import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "./types";
import {
  appendLogBatch,
  appendSystemEvent,
  clearAllLogs,
  clearSlotLogs,
  getLogSlotKeys,
  getSlotLogSummaries,
  getSlotLogs,
  getTotalLogLines,
  hasLogSlot,
  releaseAllLogs,
  releaseSlotLogs,
  subscribeAllLogs,
  subscribeSlotLogs,
} from "./logSlotStore";

function line(text: string): LogEntry {
  return { slot: 0, alias: "A", text };
}

beforeEach(() => {
  releaseAllLogs();
});

describe("logSlotStore", () => {
  it("notifies only the slot that changed", () => {
    const onZero = vi.fn();
    const onOne = vi.fn();
    subscribeSlotLogs(0, onZero);
    subscribeSlotLogs(1, onOne);

    appendLogBatch(0, [line("a")]);

    expect(onZero).toHaveBeenCalledTimes(1);
    // The whole point of the store: a burst on one engine must not wake another
    // engine's panel. This is the invariant the old global-listener bench store broke.
    expect(onOne).not.toHaveBeenCalled();
  });

  it("keeps at most the buffer window and retains the newest lines", () => {
    const batch: LogEntry[] = [];
    for (let i = 0; i < 6000; i++) batch.push(line(`l${i}`));
    appendLogBatch(0, batch);

    const kept = getSlotLogs(0);
    expect(kept.length).toBeLessThanOrEqual(5000);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[kept.length - 1].text).toBe("l5999");
    // Oldest surviving line is the one that fell off the front of the window.
    expect(kept[0].text).toBe("l1000");
  });

  it("assigns sequence numbers that are unique across slots and ascending", () => {
    appendLogBatch(0, [line("a"), line("b")]);
    appendLogBatch(1, [line("c")]);

    const seqs = [...getSlotLogs(0), ...getSlotLogs(1)].map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // React keys are `${slot}:${seq}`; uniqueness is what stops a window slide from
    // re-rendering every visible line.
    const keys = [...getSlotLogs(0), ...getSlotLogs(1)].map((e) => `${e.slot}:${e.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("clears to an empty buffer without dropping the slot", () => {
    appendLogBatch(3, [line("a")]);
    clearSlotLogs(3);

    expect(hasLogSlot(3)).toBe(true);
    expect(getSlotLogs(3).length).toBe(0);
    expect(getTotalLogLines()).toBe(0);
  });

  it("re-seeds live engine slots on a clear-all so they still render as cleared", () => {
    appendLogBatch(0, [line("a")]);
    clearAllLogs([7]);

    expect(hasLogSlot(0)).toBe(true);
    expect(hasLogSlot(7)).toBe(true);
    expect(getSlotLogs(7)).toEqual([]);
  });

  it("drops a slot entirely when its engine is released", () => {
    appendLogBatch(2, [line("a")]);
    appendSystemEvent(2, { slot: 2, alias: "A", text: "e", timestamp: "t" });
    releaseSlotLogs(2);

    expect(hasLogSlot(2)).toBe(false);
    expect(getLogSlotKeys()).not.toContain(2);
  });

  it("reports per-slot counts without exposing line text", () => {
    appendLogBatch(0, [line("a"), line("b")]);
    const summaries = getSlotLogSummaries();

    expect(summaries.get(0)?.lineCount).toBe(2);
    expect(summaries.get(0)?.firstAlias).toBe("A");
  });

  it("wakes global subscribers but not per-slot ones when clearing everything", () => {
    const onAll = vi.fn();
    const onZero = vi.fn();
    appendLogBatch(0, [line("a")]);
    subscribeAllLogs(onAll);
    subscribeSlotLogs(0, onZero);
    onAll.mockClear();
    onZero.mockClear();

    clearAllLogs([]);

    expect(onAll).toHaveBeenCalledTimes(1);
    expect(onZero).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes cleanly so a released panel stops receiving ticks", () => {
    const cb = vi.fn();
    const unsubscribe = subscribeSlotLogs(0, cb);
    unsubscribe();

    appendLogBatch(0, [line("a")]);
    expect(cb).not.toHaveBeenCalled();
  });
});
