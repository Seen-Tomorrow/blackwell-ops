import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  dispatchClearLocalStorage,
  dispatchResetAppConfig,
} from "../lib/events";

interface RecoveryModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmClassName?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function RecoveryModal({
  title,
  children,
  confirmLabel,
  confirmClassName = "value-chip-active",
  busy = false,
  onCancel,
  onConfirm,
}: RecoveryModalProps) {
  return (
    <div
      className="fixed inset-0 bg-black/70 z-[200] flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="config-form-panel rounded-sm p-6 max-w-md w-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-xs font-mono theme-accent-text mb-3 tracking-widest">{title}</h3>
        <div className="text-[10px] font-mono config-muted leading-relaxed space-y-2 mb-5">
          {children}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="value-chip text-[9px] font-mono px-3 py-1 rounded-sm disabled:opacity-40"
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`${confirmClassName} text-[9px] font-mono px-3 py-1 rounded-sm disabled:opacity-40`}
          >
            {busy ? "WORKING…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RecoveryConfig() {
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [showClearLs, setShowClearLs] = useState(false);
  const [showResetConfig, setShowResetConfig] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("get_config_dir")
      .then((path) => setConfigDir(path))
      .catch(() => setConfigDir(null));
  }, []);

  const handleResetConfig = useCallback(async () => {
    setResetting(true);
    setError(null);
    try {
      await dispatchResetAppConfig();
    } catch (err) {
      const msg = typeof err === "string" ? err : "Could not reset config.";
      setError(msg);
      setResetting(false);
    }
  }, []);

  return (
    <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4">
      <div className="max-w-2xl">
        <h2 className="text-xs font-mono theme-accent-text tracking-widest mb-2">RECOVERY</h2>
        <p className="text-[10px] font-mono config-muted leading-relaxed mb-4">
          Reset UI preferences or portable app data when something is stuck. The header CONFIG tab and
          this page stay available even when other settings are broken.
        </p>
        {configDir && (
          <p className="text-[9px] font-mono text-stealth-muted mb-6 break-all">
            Config folder: <span className="text-white/80">{configDir}</span>
          </p>
        )}

        {error && (
          <p className="text-[9px] font-mono text-telemetry-red mb-4">{error}</p>
        )}

        <div className="space-y-4">
          <section className="config-form-panel rounded-sm p-4">
            <h3 className="text-[10px] font-mono theme-accent-text tracking-wider mb-2">
              CLEAR LOCAL STORAGE
            </h3>
            <p className="text-[9px] font-mono config-muted leading-relaxed mb-3">
              Removes BlackOps UI preferences stored in the webview (theme, zoom, density, bench chips,
              catalog overrides, split widths, log search, onboarding keys, and per-provider localStorage).
              Does not touch files under <span className="text-white/70">config/</span> on disk.
            </p>
            <button
              type="button"
              onClick={() => setShowClearLs(true)}
              className="value-chip text-[9px] font-mono px-3 py-1 rounded-sm"
            >
              CLEAR LOCAL STORAGE…
            </button>
          </section>

          <section className="config-form-panel rounded-sm p-4 border border-yellow-400/20">
            <h3 className="text-[10px] font-mono text-yellow-400/90 tracking-wider mb-2">
              RESET CONFIG
            </h3>
            <p className="text-[9px] font-mono config-muted leading-relaxed mb-3">
              Resets portable app data under <span className="text-white/70">config/</span>: model paths
              (back to factory <span className="text-white/70">models/</span>), GGUF metadata cache,
              VRAM fit scan cache, learned VRAM, download queue state, and per-provider parameter
              overrides. Replays the setup checklist on reload.
            </p>
            <ul className="text-[9px] font-mono config-muted leading-relaxed mb-3 list-disc pl-4 space-y-1">
              <li>Does <span className="text-nv-green">not</span> delete GGUF model files on disk</li>
              <li>Does <span className="text-nv-green">not</span> delete foundry builds or runtime binaries</li>
              <li>Does <span className="text-nv-green">not</span> remove HuggingFace tokens in the OS keyring</li>
              <li>Stop running engines before resetting</li>
            </ul>
            <button
              type="button"
              onClick={() => setShowResetConfig(true)}
              className="value-chip text-[9px] font-mono px-3 py-1 rounded-sm text-yellow-400/90 border-yellow-400/30"
            >
              RESET CONFIG…
            </button>
          </section>
        </div>
      </div>

      {showClearLs && (
        <RecoveryModal
          title="CLEAR LOCAL STORAGE"
          confirmLabel="YES, CLEAR"
          onCancel={() => setShowClearLs(false)}
          onConfirm={() => dispatchClearLocalStorage(true)}
        >
          <p>
            This clears every <span className="text-white/80">BlackOps-*</span> key from browser
            localStorage: theme, zoom, UI density, bench control chips, catalog launch overrides,
            column layouts, log search, fusion tray state, and onboarding dismissal flags.
          </p>
          <p className="mt-3">
            <span className="text-white/80">config/</span> on disk is untouched — model paths, metadata
            cache, and provider overrides remain. The app reloads immediately.
          </p>
          <p className="mt-3 text-stealth-muted">
            Use this when UI prefs are corrupt. If the catalog or paths are wrong, use RESET CONFIG instead.
          </p>
        </RecoveryModal>
      )}

      {showResetConfig && (
        <RecoveryModal
          title="RESET CONFIG"
          confirmLabel="YES, RESET CONFIG"
          confirmClassName="value-chip text-yellow-400/90 border-yellow-400/40"
          busy={resetting}
          onCancel={() => !resetting && setShowResetConfig(false)}
          onConfirm={() => void handleResetConfig()}
        >
          <p>
            This resets the portable <span className="text-white/80">config/</span> folder next to the
            app executable{configDir ? <> ({configDir})</> : null}.
          </p>
          <p className="mt-3">
            <span className="text-white/80">Removed:</span> linked model folders (except factory{" "}
            <span className="text-white/80">models/</span>), GGUF scan cache, VRAM fit cache, learned
            VRAM, download manifests, and all per-provider parameter overrides.
          </p>
          <p className="mt-3">
            <span className="text-white/80">Kept:</span> GGUF files wherever they live on disk, foundry
            artifacts, runtime binaries, and secrets stored in the OS credential manager.
          </p>
          <p className="mt-3 text-yellow-400/80">
            The app reloads and the setup checklist runs again. Stop all engines first.
          </p>
        </RecoveryModal>
      )}
    </div>
  );
}