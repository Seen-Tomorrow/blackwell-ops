import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SecretStatus } from "../lib/types";

export default function SecretsConfig() {
  const [slots, setSlots] = useState<SecretStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const list = await invoke<SecretStatus[]>("list_app_secrets");
      setSlots(list);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showFlash = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 1400);
  };

  const startEdit = (key: string) => {
    setEditingKey(key);
    setDraft("");
    setError(null);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraft("");
  };

  const handleSave = async (key: string) => {
    const value = draft.trim();
    if (!value) {
      setError("Paste a token before saving.");
      return;
    }
    setBusyKey(key);
    setError(null);
    try {
      const updated = await invoke<SecretStatus>("set_app_secret", { key, value });
      setSlots((prev) => prev.map((s) => (s.key === key ? updated : s)));
      setEditingKey(null);
      setDraft("");
      showFlash(`${updated.label} saved to OS credential store`);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (slot: SecretStatus) => {
    if (!slot.configured) return;
    setBusyKey(slot.key);
    setError(null);
    try {
      await invoke("delete_app_secret", { key: slot.key });
      await load();
      showFlash(`${slot.label} removed`);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="type-body font-mono cfg-mut animate-pulse">LOADING SECRETS…</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="px-4 py-3 config-section-bar border-b cfg-bord--a30 flex-shrink-0">
        <h2 className="text-xs font-mono theme-accent-text tracking-widest">API TOKENS</h2>
        <p className="type-label font-mono cfg-mut--a70 mt-1 max-w-[640px] leading-relaxed">
          Stored in the OS credential manager (Windows Credential Manager). Never written to app_config.json
          or browser storage. Add tokens here for Hugging Face Hub and GitHub — the backend reads them automatically.
        </p>
        {flash && (
          <p className="type-label font-mono cfg-acc mt-2">{flash}</p>
        )}
        {error && (
          <p className="type-label font-mono cfg-dng mt-2">{error}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        {slots.map((slot) => {
          const isEditing = editingKey === slot.key;
          const busy = busyKey === slot.key;
          return (
            <div
              key={slot.key}
              className="theme-surface-row rounded-sm p-3 flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="type-body font-mono theme-accent-text tracking-wider">{slot.label}</p>
                  <p className="type-tiny font-mono cfg-mut mt-0.5">{slot.description}</p>
                </div>
                <span
                  className={`type-micro font-mono px-1.5 py-0.5 rounded-sm border flex-shrink-0 ${
                    slot.configured
                      ? "cfg-bord--acc--a40 cfg-acc--a90 cfg-fill--a10"
                      : "border-[color:var(--theme-frame-border-strong)] cfg-mut"
                  }`}
                >
                  {slot.configured ? "SET" : "NOT SET"}
                </span>
              </div>

              {slot.configured && !isEditing && slot.preview && (
                <p className="type-label font-mono cfg-mut--a80">
                  Saved: <span className="cfg-mut">{slot.preview}</span>
                </p>
              )}

              {isEditing ? (
                <div className="flex flex-col gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={slot.key === "hf_token" ? "hf_…" : "ghp_…"}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="theme-input w-full px-2 py-1.5 type-body font-mono rounded-sm focus:outline-none focus:cfg-bord--acc--a50"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={busy}
                      className="type-tiny font-mono px-2 py-0.5 rounded-sm border cfg-bord--a50 cfg-mut hover:text-white disabled:opacity-40"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSave(slot.key)}
                      disabled={busy}
                      className="type-tiny font-mono px-2 py-0.5 rounded-sm cfg-fill--a20 border cfg-bord--acc--a50 cfg-acc hover:cfg-fill--a30 disabled:opacity-40"
                    >
                      {busy ? "SAVING…" : slot.configured ? "UPDATE" : "SAVE"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 justify-end">
                  {slot.configured && (
                    <button
                      type="button"
                      onClick={() => void handleDelete(slot)}
                      disabled={busy}
                      className="type-tiny font-mono px-2 py-0.5 rounded-sm border cfg-bord--dng--a40 cfg-dng--a80 hover:cfg-fill--dng--a10 disabled:opacity-40"
                    >
                      {busy ? "…" : "REMOVE"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => startEdit(slot.key)}
                    disabled={busy}
                    className="type-tiny font-mono px-2 py-0.5 rounded-sm border cfg-bord--a50 cfg-mut hover:text-white hover:cfg-bord--acc--a40 disabled:opacity-40"
                  >
                    {slot.configured ? "CHANGE" : "ADD TOKEN"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}