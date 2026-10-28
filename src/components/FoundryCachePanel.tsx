import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FoundryWorkCacheStatus } from "../lib/types";
import type { Env } from "../lib/foundry_constants";
import FoundryClearCacheDialog from "./FoundryClearCacheDialog";

interface FoundryCachePanelProps {
  providerId: string;
  providerLabel: string;
  profile: Env;
  /** A live build owns this tree; clearing must wait. */
  disabled?: boolean;
  /** `summary` is the build form's one-line CACHING row; `full` is the CACHE view. */
  variant?: "full" | "summary";
  onManage?: () => void;
}

/**
 * Build-tree + sccache status and the CLEAR TREE action.
 *
 * Shared by the confirm modal and the FOUNDRY page. The two caches are deliberately
 * shown side by side: `work/build-{profile}` is a retained file/dependency tree,
 * sccache is a content-hash object cache, and clearing the tree keeps the latter.
 */
export default function FoundryCachePanel({
  providerId,
  providerLabel,
  profile,
  disabled = false,
  variant = "full",
  onManage,
}: FoundryCachePanelProps) {
  const [workCache, setWorkCache] = useState<FoundryWorkCacheStatus | null>(null);
  const [clearKind, setClearKind] = useState<"tree" | "sccache" | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const refreshWorkCache = useCallback(() => {
    if (!providerId) {
      setWorkCache(null);
      return;
    }
    void invoke<FoundryWorkCacheStatus>("foundry_work_cache_status", {
      providerId,
      profileId: profile,
      // The build form's summary only needs the availability bits; a multi-GB
      // sccache walk on every mount would make the form feel slow.
      includeSccacheSize: variant === "full",
    })
      .then(setWorkCache)
      .catch(() => setWorkCache(null));
  }, [providerId, profile, variant]);

  useEffect(() => {
    refreshWorkCache();
  }, [refreshWorkCache]);

  const openClearDialog = useCallback((kind: "tree" | "sccache") => {
    if (disabled || clearBusy) return;
    setClearError(null);
    setClearKind(kind);
  }, [disabled, clearBusy]);

  const confirmClear = useCallback(async () => {
    if (!clearKind || clearBusy) return;
    setClearBusy(true);
    setClearError(null);
    try {
      if (clearKind === "tree") {
        await invoke("foundry_clear_work_cache", {
          providerId,
          profileId: profile,
        });
        // Optimistic: stop advertising the old warm tree immediately. The authoritative
        // status scan walks a multi-GB work/ and can take a second or two.
        setWorkCache(prev => prev ? {
          ...prev,
          buildDirExists: false,
          cmakeCachePresent: false,
          sizeBytes: 0,
          sizeLabel: "0 B",
          workTotalBytes: Math.max(0, prev.workTotalBytes - prev.sizeBytes),
        } : prev);
      } else {
        await invoke("foundry_clear_sccache");
        setWorkCache(prev => prev ? {
          ...prev,
          sccacheSizeBytes: 0,
          sccacheSizeLabel: "0 B",
        } : prev);
      }
      setClearKind(null);
      refreshWorkCache();
    } catch (err) {
      setClearError(
        typeof err === "string"
          ? err
          : clearKind === "tree"
            ? "Could not clear the build tree."
            : "Could not clear the object cache.",
      );
      console.error(`[Foundry] Clear ${clearKind} failed:`, err);
    } finally {
      setClearBusy(false);
    }
  }, [clearKind, clearBusy, providerId, profile, refreshWorkCache]);

  if (variant === "summary") {
    const state = !workCache
      ? "CHECKING…"
      : workCache.sccacheAvailable
        ? "Files + objects"
        : "Files only";
    const ok = Boolean(workCache);
    return (
      <div className="fnd-cache-summary">
        <span className="fnd-cache-summary__label">CACHING</span>
        <span className="fnd-cache-summary__state">{state}</span>
        <span className={`fnd-cache-summary__check${ok ? " fnd-cache-summary__check--on" : ""}`} aria-hidden>
          {ok ? "✓" : "…"}
        </span>
        <button
          type="button"
          className="fnd-cache-summary__manage"
          onClick={onManage}
          disabled={!onManage}
          title="Build tree and sccache sizes, clear tree"
        >
          MANAGE →
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="foundry-cmake-cache-row fnd-cache-row fnd-cache-stack rounded-sm px-2 py-1.5">
        <div className="fnd-cache-block">
          <div className="fnd-cache-block__head">
            <div className="min-w-0">
              <p className="fnd-cache-title type-tiny font-mono uppercase tracking-wider m-0">
                Build tree <span className="fnd-cache-path">work/build-{profile}</span>
              </p>
              <p className="fnd-cache-body type-tiny font-mono leading-relaxed mt-0.5 mb-0">
                {!workCache ? (
                  <span className="fnd-cache-state--cold">CHECKING…</span>
                ) : workCache.cmakeCachePresent ? (
                  <span className="fnd-cache-state--warm">
                    WARM — {workCache.sizeLabel} retained
                  </span>
                ) : (
                  <span className="fnd-cache-state--cold">
                    COLD — full compile next time
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => openClearDialog("tree")}
              disabled={disabled || clearBusy}
              title={
                disabled
                  ? "A Foundry build is using this tree — cancel it before clearing."
                  : workCache
                    ? `This profile: ${workCache.sizeLabel} · All profiles for ${providerId}: ${workCache.workTotalLabel}`
                    : undefined
              }
              className="foundry-clear-cache-btn fnd-cache-btn shrink-0 px-2 py-1 font-mono border rounded-sm transition-colors disabled:opacity-50"
            >
              {clearBusy && clearKind === "tree"
                ? "CLEARING…"
                : `CLEAR TREE${
                    workCache
                      ? ` · ${workCache.sizeBytes > 0 ? workCache.sizeLabel : "0 B"}`
                      : ""
                  }`}
            </button>
          </div>
          <p className="fnd-cache-note type-micro font-mono config-muted leading-snug m-0 mt-1">
            Retained CMake/ninja tree. Files whose inputs did not change are reused
            by the build system — a file/dependency cache, not an object hash cache.
          </p>
        </div>

        <div className="fnd-cache-divider" aria-hidden />

        <div className="fnd-cache-block">
          <div className="fnd-cache-block__head">
            <div className="min-w-0">
              <p className="fnd-cache-title type-tiny font-mono uppercase tracking-wider m-0">
                Object cache <span className="fnd-cache-path">sccache</span>
              </p>
              <p className="fnd-cache-body type-tiny font-mono leading-relaxed mt-0.5 mb-0">
                {!workCache ? (
                  <span className="fnd-cache-state--cold">CHECKING…</span>
                ) : workCache.sccacheAvailable ? (
                  <span className="fnd-cache-state--warm">
                    READY{workCache.sccacheVersion ? ` · v${workCache.sccacheVersion}` : ""}
                    {" · "}
                    {workCache.sccacheSizeLabel ?? "…"}
                  </span>
                ) : (
                  <span className="fnd-cache-state--cold">
                    OFF — not installed
                    {workCache.sccacheSizeBytes > 0 ? ` · ${workCache.sccacheSizeLabel}` : ""}
                  </span>
                )}
              </p>
            </div>
            {workCache && (workCache.sccacheAvailable || workCache.sccacheSizeBytes > 0) && (
              <button
                type="button"
                onClick={() => openClearDialog("sccache")}
                disabled={disabled || clearBusy}
                title={
                  disabled
                    ? "A Foundry build is using the compiler cache — cancel it before clearing."
                    : `Shared sccache object cache: ${workCache.sccacheSizeLabel}`
                }
                className="foundry-clear-cache-btn fnd-cache-btn shrink-0 px-2 py-1 font-mono border rounded-sm transition-colors disabled:opacity-50"
              >
                {clearBusy && clearKind === "sccache"
                  ? "CLEARING…"
                  : `CLEAR CACHE · ${workCache.sccacheSizeLabel ?? "…"}`}
              </button>
            )}
          </div>
          <p className="fnd-cache-note type-micro font-mono config-muted leading-snug m-0 mt-1">
            {workCache?.sccacheAvailable
              ? "Objects reused by content hash across clean builds and both profiles. Separate from the build tree; only CLEAR CACHE removes them."
              : "Optional. Drop sccache.exe into toolchain/sccache to reuse objects by content hash; builds still work without it."}
          </p>
          {workCache?.sccacheAvailable && workCache.sccachePath && (
            <p
              className="fnd-cache-path-line type-micro font-mono m-0 mt-0.5"
              title={workCache.sccachePath}
            >
              {workCache.sccachePath}
            </p>
          )}
        </div>
      </div>

      <FoundryClearCacheDialog
        open={clearKind !== null}
        kind={clearKind ?? "tree"}
        providerLabel={providerLabel}
        providerId={providerId}
        profile={profile}
        sizeLabel={
          clearKind === "sccache"
            ? workCache?.sccacheSizeLabel ?? "unknown size"
            : workCache?.sizeLabel ?? "unknown size"
        }
        workTotalLabel={workCache?.workTotalLabel ?? "unknown"}
        busy={clearBusy}
        error={clearError}
        onCancel={() => {
          if (!clearBusy) setClearKind(null);
        }}
        onConfirm={() => void confirmClear()}
      />
    </>
  );
}
