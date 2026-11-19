/**
 * Get/Change draft UI — pick modal, HF search, download watch.
 * DFlash/DSpark: library pick + HF download. MTP: library pick only.
 * Depends on useCockpit.applyFullAutoCockpit for re-enable after ready.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry } from "../lib/types";
import type { DflashGetUiState } from "../components/MultiAgentBooster";
import type { DraftPickListItem } from "../lib/specDraft";
import type { RepoCompanion } from "../lib/types";
import { hfCooldownMs, noteHfError } from "../lib/hfCache";
import {
  startDflashDraftDownload,
  type DflashDraftOffer,
} from "../lib/dflashGetDraft";
import {
  catalogDraftSignals,
  draftRoleForSpecType,
  draftRoleFromModel,
  resolveDraftPathLabel,
  scoreDraftPair,
  signalContainsDspark,
  stageDraftPairing,
  type DraftRole,
} from "../lib/specDraft";
import {
  DFLASH_DRAFT_MODEL,
  MTP_DRAFT_MODEL,
  cliSpecTypeForMethod,
} from "../lib/specProfiles";
import { adapterForMethod, cliTypeForMethod } from "../lib/spec/adapters";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { useDownloadTasks } from "./useDownloadTasks";
import type {
  BrainsId,
  CodingModeId,
  SpeedBoostId,
  ThinkId,
} from "../lib/multiAgentBooster";
import type { ApplyCockpitOpts } from "./useCockpit";

export type UseSpecDraftOptions = {
  model: ModelEntry | null;
  models: ModelEntry[] | undefined;
  config: Record<string, any>;
  updateParam: (key: string, value: unknown) => void;
  dflashLibraryReady: boolean;
  speedBoost: SpeedBoostId;
  codingMode: CodingModeId;
  brains: BrainsId;
  think: ThinkId;
  powerCockpitMode: boolean;
  applyFullAutoCockpit: (
    mode: CodingModeId,
    speed: SpeedBoostId,
    brainsPick: BrainsId,
    thinkPick: ThinkId,
    opts?: ApplyCockpitOpts,
  ) => Promise<void>;
};

export function useSpecDraft({
  model,
  models,
  config,
  updateParam,
  dflashLibraryReady,
  speedBoost,
  codingMode,
  brains,
  think,
  powerCockpitMode,
  applyFullAutoCockpit,
}: UseSpecDraftOptions) {
  const [dflashGetState, setDflashGetState] = useState<DflashGetUiState>("idle");
  const [dflashGetError, setDflashGetError] = useState<string | null>(null);
  const [dflashGetOfferLabel, setDflashGetOfferLabel] = useState<string | null>(null);

  const [dflashResolveError, setDflashResolveError] = useState<string | null>(null);
  const dflashDownloadIdsRef = useRef<Set<string>>(new Set());
  const dflashScannedBatchRef = useRef("");
  const prevDflashReadyRef = useRef(false);
  const hfDownloads = useDownloadTasks("hf");

  /**
   * Local heads for the active lane. `role` decides which catalog entries qualify
   * and which score profile applies; `draftKey` decides which config value is
   * pinned to the top as the current pick.
   */
  const buildLocalPickItems = useCallback(
    (role: DraftRole, draftKey: string): DraftPickListItem[] => {
      if (!model || !models?.length) return [];
      const preferDspark = speedBoost === "dspark" && role === "external_dflash";
      const items: DraftPickListItem[] = models
        .filter((m) => {
          if (m.path === model.path) return false;
          const mRole = draftRoleFromModel(m);
          if (mRole === role) return true;
          // DSpark heads may not score as DFlash until path signal is present
          if (preferDspark && catalogDraftSignals(m).some(signalContainsDspark)) return true;
          return false;
        })
        .map((m) => {
          const isDspark = catalogDraftSignals(m).some(signalContainsDspark);
          let score = scoreDraftPair(model, m, role);
          // Prefer explicit dspark heads when Boost is DSpark
          if (preferDspark && isDspark) score = Math.max(score, 90);
          const label = resolveDraftPathLabel(m.path);
          const quant = m.quant || m.metadata?.file_type_str || "";
          const author = m.author || m.hfMeta?.author || "";
          const tag = isDspark ? "dspark" : "";
          return {
            id: m.path,
            title: label,
            meta: [author, quant, tag, m.size_str].filter(Boolean).join(" · "),
            score,
          };
        })
        .sort((a, b) => (b.score ?? -999) - (a.score ?? -999));

      const current = config[draftKey] != null ? String(config[draftKey]) : "";
      if (current) {
        items.sort((a, b) => {
          if (a.id === current) return -1;
          if (b.id === current) return 1;
          return 0;
        });
      }
      return items;
    },
    [model, models, config, speedBoost],
  );

  /** The head kind the CURRENT lane accepts (mtp / dflash / eagle3). */
  const laneDraftRole: DraftRole = useMemo(() => {
    const specType =
      speedBoost === "mtp" || speedBoost === "dflash" || speedBoost === "dspark"
        ? cliSpecTypeForMethod(speedBoost)
        : null;
    return (
      (specType ? draftRoleForSpecType(specType) : null) ??
      (speedBoost === "mtp" ? "external_mtp" : "external_dflash")
    );
  }, [speedBoost]);

  const buildLocalDflashPickItems = useCallback(
    () =>
      buildLocalPickItems(
        laneDraftRole,
        laneDraftRole === "external_mtp" ? MTP_DRAFT_MODEL : DFLASH_DRAFT_MODEL,
      ),
    [buildLocalPickItems, laneDraftRole],
  );

  /** A stale 429 from an earlier attempt must not greet the next open. */
  const clearSpecFileError = useCallback(() => {
    setDflashResolveError(null);
  }, []);

  const handleConfirmDflashPick = useCallback(async (offer: DflashDraftOffer) => {
    setDflashResolveError(null);
    setDflashGetError(null);
    setDflashGetOfferLabel(offer.label);
    setDflashGetState("downloading");
    dflashDownloadIdsRef.current = new Set();
    dflashScannedBatchRef.current = "";
    try {
      const ids = await startDflashDraftDownload(offer);
      dflashDownloadIdsRef.current = new Set(ids);
    } catch (err) {
      console.error("[dflashGetDraft] download failed:", err);
      setDflashGetState("error");
      setDflashGetError(
        typeof err === "string" ? err : "Could not start DFlash draft download",
      );
    }
  }, []);

  /**
   * Confirm a draft head that came from the repo listing (the same one the Model Hub
   * downloads from) instead of from the HF search heuristic. It is downloaded and pinned
   * exactly like a picked offer.
   */
  const handlePickRepoDraft = useCallback(
    (item: RepoCompanion) => {
      const offer: DflashDraftOffer = {
        hfModelId: item.repo_id,
        hfAuthor: item.repo_id.split("/")[0] || "unknown",
        quantType: item.precision || "FILE",
        file: {
          type: item.precision || item.file_name,
          size_bytes: item.size_bytes,
          url: item.url,
          lfsOid: item.lfs_oid,
        },
        sizeBytes: item.size_bytes,
        label: `${item.repo_id} · ${item.precision || item.file_name}`,
        score: 0,
        matchNotes: ["repo listing"],
        downloads: 0,
      };
      void handleConfirmDflashPick(offer);
    },
    [handleConfirmDflashPick],
  );
  /** The active lane's local heads, built unconditionally for the LOADOUT picker. */
  const specLocalFileRows = useMemo(
    () => buildLocalDflashPickItems(),
    [buildLocalDflashPickItems],
  );


  useEffect(() => {
    setDflashGetState("idle");
    setDflashGetError(null);
    setDflashGetOfferLabel(null);
    setDflashResolveError(null);
    dflashDownloadIdsRef.current = new Set();
    prevDflashReadyRef.current = false;
  }, [model?.path]);

  useEffect(() => {
    const wasReady = prevDflashReadyRef.current;
    prevDflashReadyRef.current = dflashLibraryReady;
    if (wasReady || !dflashLibraryReady) return;
    setDflashGetState("idle");
    setDflashGetError(null);
    if (speedBoost === "dflash" || speedBoost === "dspark") {
      void applyFullAutoCockpit(codingMode, speedBoost, brains, think, {
        powerUser: powerCockpitMode,
      });
    }
  }, [
    dflashLibraryReady,
    speedBoost,
    codingMode,
    brains,
    think,
    applyFullAutoCockpit,
    powerCockpitMode,
  ]);
  useEffect(() => {
    if (dflashGetState !== "downloading") return;
    const ids = dflashDownloadIdsRef.current;
    if (ids.size === 0) return;
    const failed = hfDownloads.find((t) => ids.has(t.id) && t.status === "failed");
    if (failed) {
      setDflashGetState("error");
      setDflashGetError(failed.error || "DFlash draft download failed");
      return;
    }
    const watched = hfDownloads.filter((t) => ids.has(t.id));
    if (watched.length === 0) return;
    if (!watched.every((t) => t.status === "completed")) return;
    const batchKey = watched.map((t) => t.id).sort().join(",");
    if (dflashScannedBatchRef.current === batchKey) return;
    dflashScannedBatchRef.current = batchKey;
    const dests = watched.map((t) => t.destPath).filter((p) => p && /\.gguf$/i.test(p));
    void (async () => {
      for (const dest of dests) {
        try {
          await invoke("scan_model_metadata_cmd", {
            modelPath: dest,
            providerId: null,
          });
        } catch (err) {
          console.error("[dflashGetDraft] post-download GGUF scan failed:", dest, err);
        }
      }
      dispatchAppEvent(EVENTS.downloadCompleted);
      setDflashGetState("idle");
    })();
  }, [hfDownloads, dflashGetState]);

  const handleConfirmLibraryDraft = useCallback(
    (path: string) => {
      if (!model) return;
      const method =
        speedBoost === "mtp" || speedBoost === "dflash" || speedBoost === "dspark"
          ? speedBoost
          : "off";
      const adapter = adapterForMethod(method);
      const draftKey = adapter?.knobs.draftModel;
      if (!adapter || !draftKey) return;
      updateParam(draftKey, path);
      stageDraftPairing(model.path, cliTypeForMethod(method) ?? adapter.cliType, path);
      setDflashResolveError(null);
      setDflashGetState("idle");
      setDflashGetError(null);
      // Keep current Boost method (mtp, dflash or dspark) when confirming a path
      void applyFullAutoCockpit(codingMode, speedBoost, brains, think, {
        powerUser: powerCockpitMode,
        preferredDraftPath: path,
      });
    },
    [
      model,
      updateParam,
      applyFullAutoCockpit,
      codingMode,
      brains,
      think,
      powerCockpitMode,
      speedBoost,
    ],
  );

  /** The active lane's local heads, built unconditionally for the LOADOUT picker. */

  // Capability drop away from external-draft boost → clear CTA noise
  useEffect(() => {
    if (speedBoost !== "dflash" && speedBoost !== "dspark") {
      setDflashGetState("idle");
      setDflashGetError(null);
      setDflashGetOfferLabel(null);
    }
  }, [speedBoost]);

  return {
    dflashGetState,
    dflashGetError,
    dflashGetOfferLabel,
    dflashResolveError,
    specLocalFileRows,
    clearSpecFileError,
    handleConfirmDflashPick,
    handlePickRepoDraft,
    handleConfirmLibraryDraft,
  };
}
