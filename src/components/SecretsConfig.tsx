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
        <span className="text-[10px] font-mono text-stealth-muted animate-pulse">LOADING SECRETS…</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="px-4 py-3 config-section-bar border-b border-stealth-border/30 flex-shrink-0">
        <h2 className="text-xs font-mono theme-accent-text tracking-widest">API TOKENS</h2>
        <p className="text-[9px] font-mono text-stealth-muted/70 mt-1 max-w-[640px] leading-relaxed">
          Stored in the OS credential manager (Windows Credential Manager). Never written to app_config.json
          or browser storage. Add tokens here for Hugging Face Hub and GitHub — the backend reads them automatically.
        </p>
        {flash && (
          <p className="text-[9px] font-mono text-nv-green mt-2">{flash}</p>
        )}
        {error && (
          <p className="text-[9px] font-mono text-red-400 mt-2">{error}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        {slots.map((slot) => {
          const isEditing = editingKey === slot.key;
          const busy = busyKey === slot.key;
          return (
            <div
              key={slot.key}
              className="rounded-sm border border-stealth-border/40 bg-stealth-surface/30 p-3 flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-mono theme-accent-text tracking-wider">{slot.label}</p>
                  <p className="text-[8px] font-mono text-stealth-muted/60 mt-0.5">{slot.description}</p>
                </div>
                <span
                  className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border flex-shrink-0 ${
                    slot.configured
                      ? "border-nv-green/40 text-nv-green/90 bg-nv-green/10"
                      : "border-stealth-border/50 text-stealth-muted/50"
                  }`}
                >
                  {slot.configured ? "SET" : "NOT SET"}
                </span>
              </div>

              {slot.configured && !isEditing && slot.preview && (
                <p className="text-[9px] font-mono text-stealth-muted/80">
                  Saved: <span className="text-stealth-muted">{slot.preview}</span>
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
                    className="w-full px-2 py-1.5 text-[10px] font-mono rounded-sm bg-black/40 border border-stealth-border/50 text-white focus:outline-none focus:border-nv-green/50"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={busy}
                      className="text-[8px] font-mono px-2 py-0.5 rounded-sm border border-stealth-border/50 text-stealth-muted hover:text-white disabled:opacity-40"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSave(slot.key)}
                      disabled={busy}
                      className="text-[8px] font-mono px-2 py-0.5 rounded-sm bg-nv-green/20 border border-nv-green/50 text-nv-green hover:bg-nv-green/30 disabled:opacity-40"
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
                      className="text-[8px] font-mono px-2 py-0.5 rounded-sm border border-red-400/40 text-red-400/80 hover:bg-red-400/10 disabled:opacity-40"
                    >
                      {busy ? "…" : "REMOVE"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => startEdit(slot.key)}
                    disabled={busy}
                    className="text-[8px] font-mono px-2 py-0.5 rounded-sm border border-stealth-border/50 text-stealth-muted hover:text-white hover:border-nv-green/40 disabled:opacity-40"
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