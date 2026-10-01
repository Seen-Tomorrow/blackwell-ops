import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type RuntimeSettingsStatus = {
  session_log: boolean;
  session_log_active: boolean;
  session_log_env: boolean | null;
  session_dir: string | null;
  cpu_affinity: string;
};

function Chip({
  active,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`type-label font-mono px-2 py-0.5 rounded-sm border ${
        active ? "value-chip-active" : "value-chip"
      } disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

export default function RuntimeConfig() {
  const [status, setStatus] = useState<RuntimeSettingsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const next = await invoke<RuntimeSettingsStatus>("get_runtime_settings");
      setStatus(next);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: { session_log?: boolean; cpu_affinity?: string }) => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<RuntimeSettingsStatus>("set_runtime_settings", {
        sessionLog: patch.session_log ?? status.session_log,
        cpuAffinity: patch.cpu_affinity ?? status.cpu_affinity,
      });
      setStatus(next);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="type-body font-mono cfg-mut animate-pulse">LOADING RUNTIME…</span>
      </div>
    );
  }

  const envLocked = status.session_log_env != null;
  const affinityOff = status.cpu_affinity === "off";

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="px-4 py-3 config-section-bar border-b cfg-bord--a30 flex-shrink-0">
        <h2 className="text-xs font-mono theme-accent-text tracking-widest">RUNTIME</h2>
        <p className="type-label font-mono cfg-mut--a70 mt-1 max-w-[720px] leading-relaxed">
          Host process policy for DEV and REL. Not a model parameter. Session log writes under
          config/logs/sessions. Affinity applies on the next launch — a running engine keeps its mask.
        </p>
        {error && <p className="type-label font-mono cfg-dng mt-2">{error}</p>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        <div className="theme-surface-row rounded-sm p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="type-body font-mono theme-accent-text tracking-wider">SESSION LOG</p>
              <p className="type-tiny font-mono cfg-mut mt-0.5 leading-relaxed">
                Engine stderr, stdout, and launch.cmd. On by default. BLACKWELL_SESSION_LOG=0/1
                overrides this switch.
              </p>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <Chip
                label="ON"
                active={status.session_log && !envLocked || status.session_log_env === true}
                disabled={busy || envLocked}
                onClick={() => void save({ session_log: true })}
              />
              <Chip
                label="OFF"
                active={!status.session_log && !envLocked || status.session_log_env === false}
                disabled={busy || envLocked}
                onClick={() => void save({ session_log: false })}
              />
            </div>
          </div>
          <p className="type-tiny font-mono cfg-mut--a70">
            {envLocked
              ? `Env lock: BLACKWELL_SESSION_LOG=${status.session_log_env ? "1" : "0"} — switch ignored.`
              : status.session_log_active
                ? "Capturing this session."
                : "Capture paused. New lines are not written until you turn it back on."}
            {status.session_dir ? ` ${status.session_dir}` : ""}
          </p>
        </div>

        <div className="theme-surface-row rounded-sm p-3 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="type-body font-mono theme-accent-text tracking-wider">CPU AFFINITY</p>
              <p className="type-tiny font-mono cfg-mut mt-0.5 leading-relaxed">
                PIN injects the V-Cache mask (ff00 on 9950X3D), --threads 8, --cpu-strict 1.
                OFF leaves llama on the full process mask. Measured win on small dense models;
                bypass here to test large / CPU-resident tables.
              </p>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <Chip
                label="PIN"
                active={!affinityOff}
                disabled={busy}
                onClick={() => void save({ cpu_affinity: "auto" })}
              />
              <Chip
                label="OFF"
                active={affinityOff}
                disabled={busy}
                onClick={() => void save({ cpu_affinity: "off" })}
              />
            </div>
          </div>
          <p className="type-tiny font-mono cfg-mut--a70">
            Next launch only. Stop and start the engine after changing this.
          </p>
        </div>
      </div>
    </div>
  );
}
