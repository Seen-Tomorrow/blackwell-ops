/**
 * MOE OVERDRIVE — a screen for one question: run this Mixture-of-Experts model as fast as this
 * rig allows. It is deliberately isolated from the forecast: no NEED/AFTER projections, no
 * placement, no fit verdict. The numbers here are measured, not projected:
 *
 *  - live t/s from the engine's own telemetry (the fusion slot store),
 *  - the VRAM ledger of the loaded engine from its `/memory` endpoint,
 *  - a cache dial sized by a short prefill + generation probe of the running server.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFusionSlot } from "../lib/fusionSlotStore";
import SliderParam from "./SliderParam";

interface OverdriveComponents {
  model_mib: number;
  kv_mib: number;
  compute_mib: number;
  host_mib: number;
}

interface OverdriveLedger {
  available: boolean;
  components: OverdriveComponents;
  free_mib: number;
  used_mib: number;
}

interface OverdriveRecord {
  model_path: string;
  model_size_bytes: number;
  ctx_size: number;
  kv_quant: string;
  split_mode: string;
  gpu_mask: string;
  draft: string;
  draft_n_max: number;
  free_pp_mib: number;
  free_tg_mib: number;
  free_after_load_mib: number;
  reserve_mib: number;
  cache_mib: number;
  tps_before: number | null;
  tps_after: number | null;
  engine_build: string | null;
  driver_version: string | null;
  measured_at: string;
}

interface OverdriveProbe {
  device: number;
  pp_free_mib: number;
  tg_free_mib: number;
  free_after_load_mib: number;
  pp_tokens: number;
  tg_tokens: number;
  pp_tps: number | null;
  tg_tps: number | null;
  reserve_mib: number;
  recommended_mib: number;
}

export interface MoeOverdriveProps {
  slotIdx: number | null;
  port: number | null;
  deviceIndex: number;
  cacheMib: number;
  /** Whether the current config keeps the experts in host RAM (cpu_moe=on). */
  cpuMoe?: boolean;
  /** Identity inputs for the stored calibration. */
  modelPath: string;
  splitMode: string;
  gpuMask: string;
  draft?: string;
  draftNMax?: number;
  /** RESET: drop the record and put the launch back on the plain path. */
  onReset?: () => void;
  /** Writes the cache knob (and the rest of the CPU-expert placement). */
  onApplyCache: (cacheMib: number) => void;
  /** Back to the forecast glass. */
  onExit: () => void;
  ctxTokens?: number;
  kvQuant?: string;
}

const CACHE_TICKS = [0, 4096, 8192, 12288, 16384, 24576, 32768];

function gib(mib: number): string {
  return `${(mib / 1024).toFixed(1)} GiB`;
}

function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "?";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 90) return "just now";
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function num(mib: number): string {
  return mib.toLocaleString("en-US");
}

export default function MoeOverdrive({
  slotIdx,
  port,
  deviceIndex,
  cacheMib,
  cpuMoe = false,
  modelPath,
  splitMode,
  gpuMask,
  draft = "",
  draftNMax = 0,
  onReset,
  onApplyCache,
  onExit,
  ctxTokens,
  kvQuant,
}: MoeOverdriveProps) {
  const fusion = useFusionSlot(slotIdx);
  const [ledger, setLedger] = useState<OverdriveLedger | null>(null);
  const [probe, setProbe] = useState<OverdriveProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [staged, setStaged] = useState<number | null>(null);
  const [dialMib, setDialMib] = useState<number>(cacheMib);
  const [record, setRecord] = useState<OverdriveRecord | null>(null);

  useEffect(() => {
    setDialMib(cacheMib);
  }, [cacheMib]);

  const recordArgs = () => ({
    modelPath,
    ctxSize: Number(ctxTokens) || 32768,
    kvQuant: kvQuant ?? "f16",
    splitMode,
    gpuMask,
    draft,
    draftNMax,
  });

  // A record from an earlier session: the dial starts at what was measured then, and the screen
  // says when. Recalibration is explicit; nothing silently replaces it.
  useEffect(() => {
    if (!modelPath) {
      setRecord(null);
      return;
    }
    let cancelled = false;
    void invoke<{ record: OverdriveRecord } | null>("moe_overdrive_record", recordArgs())
      .then((stored) => {
        if (cancelled) return;
        setRecord(stored?.record ?? null);
        if (stored?.record) setDialMib(stored.record.cache_mib);
      })
      .catch(() => {
        if (!cancelled) setRecord(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPath, ctxTokens, kvQuant, splitMode, gpuMask, draft, draftNMax]);

  const resetRecord = useCallback(async () => {
    try {
      await invoke("moe_overdrive_record_clear", recordArgs());
    } catch (e) {
      setNote(String(e).split("\n")[0]);
      return;
    }
    setRecord(null);
    setProbe(null);
    setStaged(null);
    setDialMib(0);
    onReset?.();
    setNote("record cleared - the next launch is a plain one (CPU MOE off, cache 0)");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPath, ctxTokens, kvQuant, splitMode, gpuMask, draft, draftNMax, onReset]);

  const saveRecord = useCallback(
    async (cacheMibValue: number, freePp: number, freeTg: number, freeAfter: number, reserve: number) => {
      try {
        await invoke("moe_overdrive_record_save", {
          record: {
            model_path: modelPath,
            model_size_bytes: 0,
            ctx_size: Number(ctxTokens) || 32768,
            kv_quant: kvQuant ?? "f16",
            split_mode: splitMode,
            gpu_mask: gpuMask,
            draft,
            draft_n_max: draftNMax,
            free_pp_mib: freePp,
            free_tg_mib: freeTg,
            free_after_load_mib: freeAfter,
            reserve_mib: reserve,
            cache_mib: cacheMibValue,
            tps_before: null,
            tps_after: null,
            engine_build: null,
            driver_version: null,
            measured_at: new Date().toISOString(),
          },
        });
      } catch (e) {
        setNote(String(e).split("\n")[0]);
      }
    },
    [modelPath, ctxTokens, kvQuant, splitMode, gpuMask, draft, draftNMax],
  );

  const engineUp = port != null;

  // The ledger is cheap (one HTTP call); refresh while the engine is up so the bar follows reality.
  useEffect(() => {
    if (!port) {
      setLedger(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await invoke<OverdriveLedger>("moe_overdrive_ledger", {
          port,
          deviceIndex,
        });
        if (!cancelled) setLedger(next);
      } catch {
        if (!cancelled) setLedger(null);
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [port, deviceIndex]);

  const c = ledger?.components;
  const runProbe = useCallback(async () => {
    if (port == null) {
      setNote("no engine port - launch the engine first (the probe measures the real launch)");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const result = await invoke<OverdriveProbe>("moe_overdrive_probe", {
        port,
        deviceIndex,
      });
      setProbe(result);
      if (result.recommended_mib < 1024) {
        const weights = gib(c?.model_mib ?? 0);
        const left = `${num(result.pp_free_mib)} MiB after prefill, ${num(result.tg_free_mib)} after generation`;
        setNote(
          !cpuMoe
            ? `CPU MOE is off, so the experts sit on the card (${weights} of device weights) and the launch already fills it - ${left}. The cache can only exist on top of -cmoe: ENABLE CPU MOE, relaunch, then PROBE.`
            : `CPU MOE is on, but this shape already fills the card - ${left}. Nothing is left for a cache: lower ctx or KV, or drop the draft, then PROBE again.`,
        );
      } else {
        setStaged(result.recommended_mib);
      }
    } catch (e) {
      setNote(String(e).split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }, [port, deviceIndex]);

  const liveTps = fusion
    ? fusion.genTpsInstant ?? fusion.genTpsSession ?? fusion.genTps ?? 0
    : 0;
  const ppTps = fusion?.prefillTpsSession ?? fusion?.prefillTpsInstant ?? 0;

  const segments = useMemo(() => {
    const free = ledger?.free_mib ?? 0;
    const model = c?.model_mib ?? 0;
    const kv = c?.kv_mib ?? 0;
    const compute = c?.compute_mib ?? 0;
    const cache = dialMib;
    const known = model + kv + compute + cache + free;
    if (known <= 0) return null;
    return { model, kv, compute, cache, free, total: known };
  }, [c, dialMib, ledger?.free_mib]);

  const specLine =
    fusion?.specDraftAcceptedLast != null && fusion?.specDraftGeneratedLast != null
      ? `draft ${fusion.specDraftAcceptedLast}/${fusion.specDraftGeneratedLast} accepted`
      : null;

  return (
    <div className="moe-od">
      <div className="moe-od__head">
        <span className="moe-od__title">MOE OVERDRIVE</span>
        <button type="button" className="moe-od__chip" onClick={onExit} title="Back to the forecast glass">
          ← FORECAST
        </button>
      </div>

      <div className="moe-od__hero">
        <span className="moe-od__tps">{liveTps > 0 ? liveTps.toFixed(1) : "—"}</span>
        <span className="moe-od__unit">tok/s</span>
        <span className="moe-od__sub">
          {ppTps > 0 ? `prefill ${ppTps.toFixed(0)} t/s · ` : ""}
          {fusion ? `${fusion.ctxFillPct.toFixed(0)}% ctx` : engineUp ? "engine ready" : "no engine"}
          {specLine ? ` · ${specLine}` : ""}
        </span>
      </div>

      {record && (
        <div className="moe-od__learned">
          stored: cache {num(record.cache_mib)} MiB · free {num(record.free_after_load_mib)} after load
          {record.tps_after != null ? ` · ${record.tps_after.toFixed(1)} t/s` : ""}
          {record.tps_before != null && record.tps_after != null && record.tps_before > 0
            ? ` (${(((record.tps_after / record.tps_before) - 1) * 100).toFixed(0)}% vs cache 0)`
            : ""}
          {" · "}
          {relativeAge(record.measured_at)}
        </div>
      )}
      {segments ? (
        <>
          <div className="moe-od__bar" role="img" aria-label="VRAM ledger of the loaded engine">
            <span className="moe-od__seg moe-od__seg--model" style={{ flexGrow: segments.model }} title={`weights ${num(segments.model)} MiB`} />
            <span className="moe-od__seg moe-od__seg--kv" style={{ flexGrow: segments.kv }} title={`KV ${num(segments.kv)} MiB`} />
            <span className="moe-od__seg moe-od__seg--compute" style={{ flexGrow: segments.compute }} title={`compute ${num(segments.compute)} MiB`} />
            <span className="moe-od__seg moe-od__seg--cache" style={{ flexGrow: segments.cache }} title={`expert cache ${num(segments.cache)} MiB`} />
            <span className="moe-od__seg moe-od__seg--free" style={{ flexGrow: segments.free }} title={`free ${num(segments.free)} MiB`} />
          </div>
          <div className="moe-od__legend">
            <span data-kind="model">weights {gib(segments.model)}</span>
            <span data-kind="kv">kv {gib(segments.kv)}</span>
            <span data-kind="compute">compute {gib(segments.compute)}</span>
            <span data-kind="cache">cache {gib(segments.cache)}</span>
            <span data-kind="free">free {gib(segments.free)}</span>
          </div>
        </>
      ) : (
        <div className="moe-od__empty">
          {engineUp ? "reading the engine ledger…" : "no engine loaded"}
        </div>
      )}

      <div className="moe-od__dial">
        <span className="moe-od__label">CACHE</span>
        <SliderParam
          paramKey="moe_cache_mib"
          currentValue={dialMib}
          defaultValue={0}
          onChange={(value) => setDialMib(value)}
          step={256}
          values={CACHE_TICKS}
          fieldFormat="grouped"
        />
        <span className="moe-od__unit">MiB</span>
        <button
          type="button"
          className="moe-od__chip"
          onClick={() => {
            onApplyCache(dialMib);
            if (probe) {
              void saveRecord(
                dialMib,
                probe.pp_free_mib,
                probe.tg_free_mib,
                probe.free_after_load_mib,
                probe.reserve_mib,
              );
            }
          }}
          title="Write cpu_moe=on, this cache and share 0 into the launch config"
        >
          WRITE
        </button>
      </div>

      <div className="moe-od__probe">
        <button
          type="button"
          className="moe-od__chip moe-od__chip--primary"
          onClick={() => void runProbe()}
          disabled={busy || !engineUp}
          title="Run a short prefill and a short generation against the loaded engine, then size the cache from the VRAM left"
        >
          {busy ? "PROBING…" : "PROBE + SIZE"}
        </button>
        {probe ? (
          <span className="moe-od__probe-text">
            PP {num(probe.pp_free_mib)} · TG {num(probe.tg_free_mib)} free → cache{" "}
            {num(probe.recommended_mib)} (reserve {probe.reserve_mib})
          </span>
        ) : (
          <span className="moe-od__probe-text">
            {!engineUp
              ? "no engine port - launch the engine first"
              : ctxTokens
                ? `${Math.round(ctxTokens / 1024)}K · ${kvQuant ?? "f16"} · measured from the real launch`
                : "measured from the real launch, not a model of it"}
          </span>
        )}
        {record && (
          <button
            type="button"
            className="moe-od__chip"
            onClick={() => void resetRecord()}
            title="Forget the stored calibration and return the launch to the plain path (CPU MOE off, cache 0)"
          >
            RESET
          </button>
        )}
        {!cpuMoe && (
          <button
            type="button"
            className="moe-od__chip"
            onClick={() => onApplyCache(0)}
            title="cpu_moe=on with cache 0: experts go to host RAM, the next launch can be sized and cached"
          >
            ENABLE CPU MOE
          </button>
        )}
        {staged != null && (
          <>
            <button
              type="button"
              className="moe-od__chip moe-od__chip--primary"
              onClick={() => {
                onApplyCache(staged);
                setDialMib(staged);
                setStaged(null);
              }}
              title={`Write ${num(staged)} MiB into MOE CACHE`}
            >
              APPLY {num(staged)}
            </button>
            <button type="button" className="moe-od__chip" onClick={() => setStaged(null)}>
              ✕
            </button>
          </>
        )}
      </div>

      {note && <div className="moe-od__note">{note}</div>}
    </div>
  );
}
