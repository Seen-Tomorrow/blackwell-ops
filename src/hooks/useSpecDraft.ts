/**
 * Local draft-head list + Hub download watch for the LOADOUT DRAFT picker.
 * Depends on useCockpit.applyFullAutoCockpit to apply a confirmed pick.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, RepoCompanion } from "../lib/types";
import type { DraftPickListItem } from "../lib/specDraft";
import {
  dflashVariantBadge,
  dflashVariantForDraft,
  draftRoleForSpecType,
  draftRoleFromModel,
  isDraftCompatibleWithTarget,
  resolveDraftPathLabel,
  scoreDraftPair,
  type DraftRole,
} from "../lib/specDraft";
import {
  DFLASH_DRAFT_MODEL,
  MTP_DRAFT_MODEL,
  cliSpecTypeForMethod,
} from "../lib/specProfiles";
import { adapterForMethod } from "../lib/spec/adapters";
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
  const [watchingDownload, setWatchingDownload] = useState(false);
  const downloadIdsRef = useRef<Set<string>>(new Set());
  const scannedBatchRef = useRef("");
  const prevDflashReadyRef = useRef(false);
  const hfDownloads = useDownloadTasks("hf");

  /** The head kind the active SPEC lane accepts (mtp / dflash / eagle3). */
  const laneDraftRole: DraftRole = useMemo(() => {
    const specType =
      speedBoost === "mtp" || speedBoost === "dflash"
        ? cliSpecTypeForMethod(speedBoost)
        : null;
    return (
      (specType ? draftRoleForSpecType(specType) : null) ??
      (speedBoost === "mtp" ? "external_mtp" : "external_dflash")
    );
  }, [speedBoost]);

  /** Local heads for the active lane, tagged with GGUF geometry compatibility and sorted by match + precision. */
  const specLocalFileRows = useMemo((): DraftPickListItem[] => {
    if (!model || !models?.length) return [];
    const draftKey =
      laneDraftRole === "external_mtp" ? MTP_DRAFT_MODEL : DFLASH_DRAFT_MODEL;
    const current = config[draftKey] != null ? String(config[draftKey]) : "";
    const items: DraftPickListItem[] = models
      .filter((m) => {
        if (m.path === model.path) return false;
        return draftRoleFromModel(m) === laneDraftRole;
      })
      .map((m) => {
        const score = scoreDraftPair(model, m, laneDraftRole);
        const compatible =
          m.path === current || isDraftCompatibleWithTarget(model, m, laneDraftRole);
        const label = resolveDraftPathLabel(m.path);
        const quant = (m.quant || m.metadata?.file_type_str || "").toUpperCase();
        const author = m.author || m.hfMeta?.author || "";
        const tag =
          laneDraftRole === "external_dflash"
            ? dflashVariantBadge(dflashVariantForDraft(m))
            : "MTP";
        return {
          id: m.path,
          title: label,
          meta: [author, quant, tag, m.size_str].filter(Boolean).join(" · "),
          score,
          compatible,
          quant: quant || undefined,
          variantTag: tag,
        };
      })
      .sort((a, b) => {
        if (Boolean(a.compatible) !== Boolean(b.compatible)) {
          return a.compatible ? -1 : 1;
        }
        return (b.score ?? -999) - (a.score ?? -999);
      });

    if (current) {
      items.sort((a, b) => {
        if (a.id === current) return -1;
        if (b.id === current) return 1;
        return 0;
      });
    }
    return items;
  }, [model, models, config, laneDraftRole]);

  /** Enqueue a Hub draft head download and scan its GGUF metadata when complete. */
  const handlePickRepoDraft = useCallback(async (item: RepoCompanion) => {
    downloadIdsRef.current = new Set();
    scannedBatchRef.current = "";
    setWatchingDownload(true);
    try {
      const ids = await invoke<string[]>("start_quant_download", {
        hfModelId: item.repo_id,
        hfAuthor: item.repo_id.split("/")[0] || "unknown",
        quantType: item.precision || "FILE",
        ggufFile: {
          type: item.precision || item.file_name,
          size_bytes: item.size_bytes,
          url: item.url,
          lfsOid: item.lfs_oid,
        },
      });
      downloadIdsRef.current = new Set(ids);
    } catch (err) {
      console.error("[useSpecDraft] draft download failed:", err);
      setWatchingDownload(false);
    }
  }, []);

  useEffect(() => {
    setWatchingDownload(false);
    downloadIdsRef.current = new Set();
    prevDflashReadyRef.current = false;
  }, [model?.path]);

  useEffect(() => {
    const wasReady = prevDflashReadyRef.current;
    prevDflashReadyRef.current = dflashLibraryReady;
    if (wasReady || !dflashLibraryReady) return;
    if (speedBoost === "dflash") {
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
    if (!watchingDownload) return;
    const ids = downloadIdsRef.current;
    if (ids.size === 0) return;
    if (hfDownloads.some((t) => ids.has(t.id) && t.status === "failed")) {
      setWatchingDownload(false);
      return;
    }
    const watched = hfDownloads.filter((t) => ids.has(t.id));
    if (watched.length === 0 || !watched.every((t) => t.status === "completed")) return;
    const batchKey = watched.map((t) => t.id).sort().join(",");
    if (scannedBatchRef.current === batchKey) return;
    scannedBatchRef.current = batchKey;
    const dests = watched.map((t) => t.destPath).filter((p) => p && /\.gguf$/i.test(p));
    void (async () => {
      for (const dest of dests) {
        try {
          await invoke("scan_model_metadata_cmd", {
            modelPath: dest,
            providerId: null,
          });
        } catch (err) {
          console.error("[useSpecDraft] post-download GGUF scan failed:", dest, err);
        }
      }
      dispatchAppEvent(EVENTS.downloadCompleted);
      setWatchingDownload(false);
    })();
  }, [hfDownloads, watchingDownload]);

  const handleConfirmLibraryDraft = useCallback(
    (path: string) => {
      if (!model) return;
      const method =
        speedBoost === "mtp" || speedBoost === "dflash"
          ? speedBoost
          : "off";
      const adapter = adapterForMethod(method);
      const draftKey = adapter?.knobs?.draftModel;
      if (!adapter || !draftKey) return;
      updateParam(draftKey, path);
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

  return {
    specLocalFileRows,
    handlePickRepoDraft,
    handleConfirmLibraryDraft,
  };
}
