/**
 * DFlash Get/Change draft UI — pick modal, HF search, download watch.
 * Depends on useCockpit.applyFullAutoCockpit for re-enable after ready.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelEntry } from "../lib/types";
import type { DflashGetUiState } from "../components/MultiAgentBooster";
import type { DraftPickListItem, DraftPickMode } from "../components/DraftPickModal";
import {
  describeMainForDflashPick,
  findDflashDraftCandidates,
  resolveDflashOfferFromHfId,
  startDflashDraftDownload,
  type DflashDraftOffer,
} from "../lib/dflashGetDraft";
import {
  draftRoleFromModel,
  resolveDraftPathLabel,
  saveDraftPairing,
  scoreDraftPair,
} from "../lib/specDraft";
import { DFLASH_DRAFT_MODEL } from "../lib/specProfiles";
import { useDownloadTasks } from "./useDownloadTasks";
import type {
  BrainsId,
  CodingModeId,
  SpeedBoostId,
  ThinkId,
} from "../lib/multiAgentBooster";
import type { ApplyCockpitOpts } from "./useCockpit";

export type UseDflashDraftOptions = {
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

export function useDflashDraft({
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
}: UseDflashDraftOptions) {
  const [dflashGetState, setDflashGetState] = useState<DflashGetUiState>("idle");
  const [dflashGetError, setDflashGetError] = useState<string | null>(null);
  const [dflashGetOfferLabel, setDflashGetOfferLabel] = useState<string | null>(null);
  const [dflashCandidates, setDflashCandidates] = useState<DflashDraftOffer[]>([]);
  const [dflashPickOpen, setDflashPickOpen] = useState(false);
  const [dflashPickMode, setDflashPickMode] = useState<DraftPickMode>("hf-download");
  const [libraryPickItems, setLibraryPickItems] = useState<DraftPickListItem[]>([]);
  const [dflashResolving, setDflashResolving] = useState(false);
  const [dflashResolveError, setDflashResolveError] = useState<string | null>(null);
  const dflashDownloadIdsRef = useRef<Set<string>>(new Set());
  const prevDflashReadyRef = useRef(false);
  const hfDownloads = useDownloadTasks("hf");

  const buildLocalDflashPickItems = useCallback((): DraftPickListItem[] => {
    if (!model || !models?.length) return [];
    const items: DraftPickListItem[] = models
      .filter(
        (m) =>
          m.path !== model.path
          && (draftRoleFromModel(m) === "external_dflash"
            || draftRoleFromModel(m) === "external_mtp"),
      )
      .map((m) => {
        const score = scoreDraftPair(model, m, "external_dflash");
        const label = resolveDraftPathLabel(m.path);
        const quant = m.quant || m.metadata?.file_type_str || "";
        const author = m.author || m.hfMeta?.author || "";
        return {
          id: m.path,
          title: label,
          meta: [author, quant, m.size_str].filter(Boolean).join(" · "),
          score,
          draftRole: draftRoleFromModel(m),
        };
      })
      .sort((a, b) => (b.score ?? -999) - (a.score ?? -999));

    const current = config.spec_draft_model != null ? String(config.spec_draft_model) : "";
    if (current) {
      items.sort((a, b) => {
        if (a.id === current) return -1;
        if (b.id === current) return 1;
        return 0;
      });
    }
    return items;
  }, [model, models, config.spec_draft_model]);

  const loadDflashHfCandidates = useCallback(async () => {
    if (!model) return;
    setDflashGetState("searching");
    setDflashResolveError(null);
    try {
      const offers = await findDflashDraftCandidates(model, 3);
      setDflashCandidates(offers);
      setDflashGetState("idle");
    } catch (err) {
      console.error("[dflashGetDraft] search failed:", err);
      setDflashCandidates([]);
      setDflashGetState("idle");
      setDflashResolveError(
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Search failed — paste HF id manually",
      );
    }
  }, [model]);

  const handleGetDflashDraft = useCallback(async () => {
    if (!model) return;
    setDflashGetError(null);
    setDflashGetOfferLabel(null);
    setDflashCandidates([]);
    setLibraryPickItems(buildLocalDflashPickItems());
    setDflashPickMode("hf-download");
    setDflashResolving(false);
    setDflashResolveError(null);
    dflashDownloadIdsRef.current = new Set();
    setDflashPickOpen(true);
    setDflashGetState("searching");
    await loadDflashHfCandidates();
  }, [model, buildLocalDflashPickItems, loadDflashHfCandidates]);

  const handleChangeDflashDraft = useCallback(() => {
    if (!model) return;
    const items = buildLocalDflashPickItems();
    setDflashPickMode("library");
    setLibraryPickItems(items);
    setDflashCandidates([]);
    setDflashResolveError(null);
    setDflashPickOpen(true);
    setDflashGetState("idle");
  }, [model, buildLocalDflashPickItems]);

  const handleCancelDflashPick = useCallback(() => {
    if (dflashResolving) return;
    setDflashPickOpen(false);
    setDflashCandidates([]);
    setLibraryPickItems([]);
    setDflashResolveError(null);
    setDflashResolving(false);
    setDflashGetState("idle");
  }, [dflashResolving]);

  const handleConfirmDflashPick = useCallback(async (offer: DflashDraftOffer) => {
    setDflashPickOpen(false);
    setDflashResolveError(null);
    setDflashResolving(false);
    setDflashGetError(null);
    setDflashGetOfferLabel(offer.label);
    setDflashGetState("downloading");
    dflashDownloadIdsRef.current = new Set();
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

  const handleConfirmDflashManual = useCallback(
    async (hfModelId: string) => {
      if (!model) return;
      setDflashResolving(true);
      setDflashResolveError(null);
      try {
        const offer = await resolveDflashOfferFromHfId(model, hfModelId);
        await handleConfirmDflashPick(offer);
      } catch (err) {
        console.error("[dflashGetDraft] manual resolve failed:", err);
        setDflashResolveError(
          typeof err === "string"
            ? err
            : err instanceof Error
              ? err.message
              : "Could not resolve HF repo",
        );
      } finally {
        setDflashResolving(false);
      }
    },
    [model, handleConfirmDflashPick],
  );

  const handleConfirmLibraryDraft = useCallback(
    (path: string) => {
      if (!model) return;
      updateParam(DFLASH_DRAFT_MODEL, path);
      saveDraftPairing(model.path, "draft-dflash", path);
      setDflashPickOpen(false);
      setLibraryPickItems([]);
      setDflashResolveError(null);
      setDflashGetState("idle");
      setDflashGetError(null);
      void applyFullAutoCockpit(codingMode, "dflash", brains, think, {
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
    ],
  );

  const dflashLocalPickItems = useMemo(() => libraryPickItems, [libraryPickItems]);

  const dflashPickInitialSelectedId = useMemo(() => {
    return config[DFLASH_DRAFT_MODEL] != null ? String(config[DFLASH_DRAFT_MODEL]) : null;
  }, [config]);

  const dflashMainDescribe = useMemo(
    () => (model ? describeMainForDflashPick(model) : null),
    [model],
  );

  useEffect(() => {
    setDflashGetState("idle");
    setDflashGetError(null);
    setDflashGetOfferLabel(null);
    setDflashCandidates([]);
    setLibraryPickItems([]);
    setDflashPickOpen(false);
    setDflashResolving(false);
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
    if (speedBoost === "dflash") {
      void applyFullAutoCockpit(codingMode, "dflash", brains, think, {
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
    }
  }, [hfDownloads, dflashGetState]);

  // Capability drop away from dflash → clear CTA noise
  useEffect(() => {
    if (speedBoost !== "dflash") {
      setDflashGetState("idle");
      setDflashGetError(null);
      setDflashGetOfferLabel(null);
    }
  }, [speedBoost]);

  return {
    dflashGetState,
    dflashGetError,
    dflashGetOfferLabel,
    dflashCandidates,
    dflashPickOpen,
    dflashPickMode,
    dflashResolving,
    dflashResolveError,
    dflashLocalPickItems,
    dflashPickInitialSelectedId,
    dflashMainDescribe,
    handleGetDflashDraft,
    handleChangeDflashDraft,
    handleCancelDflashPick,
    handleConfirmDflashPick,
    handleConfirmDflashManual,
    handleConfirmLibraryDraft,
    loadDflashHfCandidates,
  };
}
