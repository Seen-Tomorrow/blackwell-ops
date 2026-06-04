import React, { useState, useEffect, useCallback } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import { KEYS, normalizeUiGroup } from "../lib/storage";

interface CreatorForm {
  key: string;
  label: string;
  values: (string | number)[];
  defaultValue: string | number | "";
  uiGroup: string;
  customGroup: string;
  ptype: string;
  flag: string;
  mapId: string;
  subParams: Record<string, string>;
}

const DEFAULT_FORM: CreatorForm = {
  key: "",
  label: "",
  values: [],
  defaultValue: "",
  uiGroup: "",
  customGroup: "",
  ptype: "arg_select",
  flag: "",
  mapId: "",
  subParams: {},
};

function parseValue(v: string): string | number {
  const t = v.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

export default function ParamCreatorModal({
  existingKeys,
  existingGroups,
  onClose,
  onSubmit,
}: {
  existingKeys: string[];
  existingGroups: string[];
  onClose: () => void;
  onSubmit: (def: Omit<UserEditedTemplateParam, "order">) => void;
}) {
  const [mode, setMode] = useState<"simple" | "advanced">(() => {
    try { return (localStorage.getItem(KEYS.paramCreatorMode) as "simple" | "advanced") || "simple"; } catch { return "simple"; }
  });

  const [form, setForm] = useState<CreatorForm>({ ...DEFAULT_FORM });
  const [newValInput, setNewValInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Auto-fill label from key
  useEffect(() => {
    if (form.key && !form.label) {
      setForm(prev => ({ ...prev, label: form.key }));
    }
  }, [form.key]);

  const updateField = useCallback((field: keyof CreatorForm, val: any) => {
    setForm(prev => ({ ...prev, [field]: val }));
    setError(null);
  }, []);

  // ── Value management ────────────────────────────────
  const addValue = () => {
    const t = newValInput.trim();
    if (!t) return;
    const p = parseValue(t);
    if (form.values.some(v => String(v) === String(p))) return;
    setForm(prev => ({
      ...prev,
      values: [...prev.values, p],
      defaultValue: prev.defaultValue === "" ? p : prev.defaultValue,
    }));
    setNewValInput("");
  };

  const removeValue = (idx: number) => {
    setForm(prev => {
      const removed = prev.values[idx];
      const newVals = prev.values.filter((_, i) => i !== idx);
      let newDefault = prev.defaultValue;
      if (String(newDefault) === String(removed)) {
        newDefault = newVals.length > 0 ? newVals[0] : "";
      }
      // Also remove sub_params entry for this value
      const sp = { ...prev.subParams };
      delete sp[String(removed)];
      return { ...prev, values: newVals, defaultValue: newDefault, subParams: sp };
    });
  };

  const setDefaultValue = (val: string | number) => {
    updateField("defaultValue", val);
  };

  // ── Sub-params management ───────────────────────────
  const updateSubParam = (valueKey: string, argsText: string) => {
    setForm(prev => {
      const sp = { ...prev.subParams };
      if (argsText.trim()) sp[valueKey] = argsText;
      else delete sp[valueKey];
      return { ...prev, subParams: sp };
    });
  };

  // ── Submit validation + build UserEditedTemplateParam ──────────────
  const handleSubmit = () => {
    if (!form.key.trim()) { setError("Parameter key is required"); return; }
    if (existingKeys.includes(form.key.trim())) { setError(`Parameter '${form.key}' already exists`); return; }
    if (form.values.length === 0) { setError("At least one value is required"); return; }

    const rawGroup = form.uiGroup === "__custom__" ? form.customGroup : form.uiGroup;
    const group = rawGroup ? normalizeUiGroup(rawGroup) : "";
    if (!group && form.uiGroup !== "__custom__") { /* no group = Feature Flags default */ }

    // Build sub_params from form.subParams (text → string[])
    const subParams: Record<string, string[]> | undefined = Object.keys(form.subParams).length > 0
      ? Object.fromEntries(
          Object.entries(form.subParams)
            .filter(([, v]) => v.trim())
            .map(([k, v]) => [k, v.trim().split(/\s+/).filter(Boolean)])
        ) as Record<string, string[]>
      : undefined;

    const def: Omit<UserEditedTemplateParam, "order"> = {
      key: form.key.trim(),
      label: form.label || form.key.trim(),
      values: form.values,
      hidden: false,
      defaultValue: form.defaultValue !== "" ? form.defaultValue : undefined,
      ui_group: group || undefined,
    };

    // Always set ptype — defaults to "arg_select" in simple mode
    def.ptype = form.ptype as UserEditedTemplateParam["ptype"];
    if (form.flag && form.ptype !== "logic_only") {
      def.flag = form.flag;
    }
    if (subParams) {
      def.sub_params = subParams;
    }

    onSubmit(def);
  };

  const isCustomGroup = form.uiGroup === "__custom__";

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-stealth-panel border border-yellow-400/40 rounded-lg w-full max-w-xl mx-4 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-stealth-border/30">
          <h2 className="text-xs font-mono text-yellow-400 tracking-wider">ADD PARAMETER</h2>
          <button onClick={onClose} className="text-stealth-muted hover:text-white transition-colors leading-none px-1">✕</button>
        </div>

        {/* Mode toggle */}
        <div className="px-4 py-2 flex items-center gap-2 border-b border-stealth-border/20">
          <button
            onClick={() => setMode("simple")}
            className={`text-[9px] font-mono px-2 py-0.5 transition-colors ${mode === "simple" ? "bg-yellow-400/20 text-yellow-400 border border-yellow-400/40" : "text-stealth-muted hover:text-white"}`}
          >
            SIMPLE
          </button>
          <button
            onClick={() => setMode("advanced")}
            className={`text-[9px] font-mono px-2 py-0.5 transition-colors ${mode === "advanced" ? "bg-yellow-400/20 text-yellow-400 border border-yellow-400/40" : "text-stealth-muted hover:text-white"}`}
          >
            ADVANCED
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Error */}
          {error && (
            <div className="text-[9px] font-mono text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-1 rounded">{error}</div>
          )}

          {/* Key + Label row */}
          <div className="flex gap-3">
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-[8px] font-mono text-stealth-muted">key</span>
              <input
                type="text"
                value={form.key}
                onChange={e => updateField("key", e.target.value)}
                placeholder="MyParamKey"
                className="bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5 placeholder:text-stealth-muted/50"
              />
            </div>
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-[8px] font-mono text-stealth-muted">label</span>
              <input
                type="text"
                value={form.label}
                onChange={e => updateField("label", e.target.value)}
                placeholder="Auto from key"
                className="bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5 placeholder:text-stealth-muted/50"
              />
            </div>
          </div>

          {/* Group selector */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[8px] font-mono text-stealth-muted">group</span>
            <select
              value={form.uiGroup || "__none__"}
              onChange={e => updateField("uiGroup", e.target.value === "__none__" ? "" : e.target.value)}
              className="bg-[#1a1a2e] border border-stealth-border/50 text-[10px] font-mono text-white px-2 py-1 focus:outline-none rounded"
            >
              <option value="__none__">— No group (Feature Flags) —</option>
              {existingGroups.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
              <option value="__custom__">✏ Custom...</option>
            </select>
            {isCustomGroup && (
              <input
                type="text"
                value={form.customGroup}
                onChange={e => updateField("customGroup", e.target.value)}
                placeholder="New group name..."
                className="bg-transparent border-b border-yellow-400/30 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5 mt-1 placeholder:text-stealth-muted/50"
              />
            )}
          </div>

          {/* Values */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[8px] font-mono text-stealth-muted">values</span>
            <div className="flex items-center gap-1.5 flex-wrap min-h-[24px] py-1">
              {form.values.map((v, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 border text-[9px] font-mono rounded-sm ${
                    String(v) === String(form.defaultValue)
                      ? "border-nv-green/70 bg-nv-green/20 text-nv-green"
                      : "border-stealth-border/40 text-white"
                  }`}
                >
                  {String(v)}
                  <button onClick={() => removeValue(i)} className="text-red-400/50 hover:text-red-400 leading-none ml-0.5">×</button>
                  <button
                    onClick={() => setDefaultValue(v)}
                    title="Set as default"
                    className={`leading-none ${String(v) === String(form.defaultValue) ? "text-nv-green" : "text-stealth-muted/50 hover:text-nv-green"}`}
                  >
                    *
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1.5 items-center">
              <input
                type="text"
                value={newValInput}
                onChange={e => setNewValInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addValue(); } }}
                placeholder="+ add value"
                className="flex-1 bg-transparent border-b border-stealth-border/50 text-[9px] font-mono text-white focus:outline-none px-1 py-0.5 placeholder:text-stealth-muted/50"
              />
              <button
                onClick={addValue}
                disabled={!newValInput.trim()}
                className="text-[8px] font-mono text-nv-green/60 hover:text-nv-green transition-colors disabled:opacity-30 px-1"
              >
                +VAL
              </button>
            </div>
          </div>

          {/* ── Advanced fields ─────────────────────── */}
          {mode === "advanced" && (
            <>
              <div className="border-t border-stealth-border/30 pt-2 space-y-2">
                {/* ptype + flag row */}
                <div className="flex gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[8px] font-mono text-stealth-muted">ptype</span>
                    <select
                      value={form.ptype}
                      onChange={e => updateField("ptype", e.target.value)}
                      className="bg-[#1a1a2e] border border-stealth-border/50 text-[10px] font-mono text-white px-1 py-0.5 focus:outline-none rounded"
                    >
                      <option value="arg_select">arg_select</option>
                      <option value="slider">slider</option>
                      <option value="logic_only">logic_only</option>
                      <option value="switch_onoff">switch_onoff</option>
                      <option value="switch_inverted">switch_inverted</option>
                    </select>
                  </div>

                  {form.ptype !== "logic_only" && (
                    <div className="flex flex-col gap-0.5 flex-1">
                      <span className="text-[8px] font-mono text-stealth-muted">flag</span>
                      <input
                        type="text"
                        value={form.flag}
                        onChange={e => updateField("flag", e.target.value)}
                        placeholder="--my-flag"
                        className="w-full bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5"
                      />
                    </div>
                  )}

                </div>

                {/* Sub-params per value */}
                {form.values.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[8px] font-mono text-stealth-muted">sub_params</span>
                    {form.values.map(v => {
                      const k = String(v);
                      return (
                        <div key={k} className="flex items-center gap-1">
                          <span className="text-[9px] font-mono text-nv-green/60 min-w-[48px]">{k}</span>
                          <input
                            type="text"
                            value={form.subParams[k] || ""}
                            onChange={e => updateSubParam(k, e.target.value)}
                            placeholder="-flag1 val1 ..."
                            className="flex-1 bg-transparent border-b border-stealth-border/30 text-[9px] font-mono text-white focus:outline-none px-1 py-0.5"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-stealth-border/30">
          <button
            onClick={onClose}
            className="px-3 py-1 text-[9px] font-mono border border-stealth-border/40 text-stealth-muted hover:text-white transition-colors"
          >
            CANCEL
          </button>
          <button
            onClick={handleSubmit}
            disabled={!form.key.trim() || form.values.length === 0}
            className="px-3 py-1 text-[9px] font-mono border border-yellow-400/60 bg-yellow-400/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors disabled:opacity-30"
          >
            ADD PARAMETER
          </button>
        </div>
      </div>
    </div>
  );
}
