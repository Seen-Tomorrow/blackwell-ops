import { listen } from "@tauri-apps/api/event";
import { frontendPollEnabled } from "./debugFlags";
import type { LogBatch, SystemEvent } from "./types";
import {
  LOAD_PHASE_ORDER,
  type LoadPhaseId,
  maxPhase,
  parseLoadLogLine,
} from "./fusionLoadParser";

const PHASE_DWELL_MS = 750;
const DWELL_PHASES: LoadPhaseId[] = ["server", "ready"];

export interface BooterSession {
  slotIdx: number;
  port: number;
  logPhase: LoadPhaseId;
  phase: LoadPhaseId;
  tickerLines: string[];
  layerCurrent: number;
  layerTotal: number;
  pingAttempts: number;
  startedAt: number;
  phaseSince: number;
  diskReadMibPerS: number;
  logGpuIndices: number[];
  loadFailed: boolean;
  loadErrorReason: string;
  vramBaseline: Record<number, number>;
  baselineCaptured: boolean;
  revision: number;
}

function createSession(slotIdx: number, port: number, modelLayerTotal: number): BooterSession {
  const now = Date.now();
  return {
    slotIdx,
    port,
    logPhase: "spawn",
    phase: "spawn",
    tickerLines: [],
    layerCurrent: 0,
    layerTotal: modelLayerTotal,
    pingAttempts: 0,
    startedAt: now,
    phaseSince: now,
    diskReadMibPerS: 0,
    logGpuIndices: [],
    loadFailed: false,
    loadErrorReason: "",
    vramBaseline: {},
    baselineCaptured: false,
    revision: 0,
  };
}

const sessions = new Map<number, BooterSession>();
const subscribers = new Map<number, Set<() => void>>();

function notify(slotIdx: number) {
  subscribers.get(slotIdx)?.forEach((cb) => cb());
}

function bump(session: BooterSession) {
  session.revision += 1;
  notify(session.slotIdx);
}

function applyLogPhase(session: BooterSession, incoming: LoadPhaseId) {
  session.logPhase = maxPhase(session.logPhase, incoming);
}

function markLoadFailed(session: BooterSession, reason: string) {
  session.loadFailed = true;
  session.loadErrorReason = reason.trim() || "Model load failed";
  bump(session);
}

function processLogText(session: BooterSession, text: string) {
  const parsed = parseLoadLogLine(text);
  let changed = false;

  if (parsed.tickerLine) {
    session.tickerLines = [...session.tickerLines.slice(-2), parsed.tickerLine];
    changed = true;
  }
  if (parsed.phase) {
    const prev = session.logPhase;
    applyLogPhase(session, parsed.phase);
    if (session.logPhase !== prev) changed = true;
  }
  if (parsed.loadFailed) {
    markLoadFailed(session, parsed.loadErrorReason ?? text);
    return;
  }
  if (parsed.layerCurrent != null) {
    const next = Math.max(session.layerCurrent, parsed.layerCurrent);
    if (next !== session.layerCurrent) {
      session.layerCurrent = next;
      changed = true;
    }
  }
  if (parsed.layerTotal != null) {
    const next = Math.max(session.layerTotal, parsed.layerTotal);
    if (next !== session.layerTotal) {
      session.layerTotal = next;
      changed = true;
    }
  }
  if (parsed.gpuIndex != null && !session.logGpuIndices.includes(parsed.gpuIndex)) {
    session.logGpuIndices = [...session.logGpuIndices, parsed.gpuIndex].sort((a, b) => a - b);
    changed = true;
  }

  if (changed) bump(session);
}

function tickPhaseLadder() {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.loadFailed) continue;

    const logIdx = LOAD_PHASE_ORDER.indexOf(session.logPhase);
    const dispIdx = LOAD_PHASE_ORDER.indexOf(session.phase);
    if (dispIdx >= logIdx) continue;

    if (DWELL_PHASES.includes(session.phase) && now - session.phaseSince < PHASE_DWELL_MS) {
      continue;
    }

    session.phase = LOAD_PHASE_ORDER[dispIdx + 1];
    session.phaseSince = now;
    bump(session);
  }
}

let listenersReady = false;

function ensureGlobalListeners() {
  if (listenersReady) return;
  listenersReady = true;

  void listen<LogBatch>("engine-log-batch", (e) => {
    const batch = e.payload;
    const session = sessions.get(batch.slot);
    if (!session || session.loadFailed) return;
    for (const entry of batch.entries) {
      processLogText(session, entry.text);
    }
  });

  void listen<SystemEvent>("engine-system", (e) => {
    const ev = e.payload;
    const session = sessions.get(ev.slot);
    if (!session || session.loadFailed) return;
    processLogText(session, ev.text);
    if (ev.text.includes("readiness=")) {
      const prev = session.logPhase;
      applyLogPhase(session, "ready");
      if (session.logPhase !== prev) bump(session);
    }
  });

  void listen<{ slot: number; reason?: string }>("engine-load-failed", (e) => {
    const session = sessions.get(e.payload.slot);
    if (!session) return;
    markLoadFailed(session, e.payload.reason ?? "Model load failed");
  });

  void listen<{ slot: number }>("slot-cleared", (e) => {
    clearBooterSession(e.payload.slot);
  });

  void listen("engines-all-stopped", () => {
    clearAllBooterSessions();
  });

  if (frontendPollEnabled()) {
    setInterval(tickPhaseLadder, 40);
  }

  if (frontendPollEnabled()) {
    setInterval(() => {
    for (const session of sessions.values()) {
      if (session.loadFailed || session.phase === "ready") continue;
      session.pingAttempts += 1;
      bump(session);
    }
    }, 500);
  }
}

export function subscribeBooterSession(slotIdx: number, cb: () => void): () => void {
  ensureGlobalListeners();
  let set = subscribers.get(slotIdx);
  if (!set) {
    set = new Set();
    subscribers.set(slotIdx, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) subscribers.delete(slotIdx);
  };
}

export function getBooterSession(slotIdx: number): BooterSession | null {
  return sessions.get(slotIdx) ?? null;
}

export function getBooterRevision(slotIdx: number): number {
  return sessions.get(slotIdx)?.revision ?? 0;
}

export function initBooterSession(
  slotIdx: number,
  port: number,
  modelLayerTotal: number,
): BooterSession {
  ensureGlobalListeners();
  const existing = sessions.get(slotIdx);
  if (existing && existing.port === port && !existing.loadFailed) {
    if (modelLayerTotal > existing.layerTotal) {
      existing.layerTotal = modelLayerTotal;
      bump(existing);
    }
    return existing;
  }

  const session = createSession(slotIdx, port, modelLayerTotal);
  sessions.set(slotIdx, session);
  bump(session);
  return session;
}

export function patchBooterSession(slotIdx: number, patch: Partial<BooterSession>) {
  const session = sessions.get(slotIdx);
  if (!session) return;
  Object.assign(session, patch);
  bump(session);
}

export function clearBooterSession(slotIdx: number) {
  if (sessions.delete(slotIdx)) {
    notify(slotIdx);
  }
}

export function clearAllBooterSessions() {
  if (sessions.size === 0) return;
  const slots = [...sessions.keys()];
  sessions.clear();
  slots.forEach(notify);
}

export function elapsedSecForSession(session: BooterSession): number {
  return Math.floor((Date.now() - session.startedAt) / 1000);
}