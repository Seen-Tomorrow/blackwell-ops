// Full param metadata editor — label, ptype, flag, group, values, sub-params.
// Extracted from ParamConfigPanel.

import { useState } from "react";
import { SYSTEM_CATALOG_PARAM_TOOLTIP } from "../lib/systemParams";

export interface ParamMetaForm {
  label: string;
  ptype: string;
  flag: string;
  pattern: string;
  uiGroup: string;
  customGroup: string;
  values: (string | number)[];
  defaultValue: string | number;
  subParams: Record<string, string>;
}

interface ParamMetaEditorProps {
  editingKey: string;
  form: ParamMetaForm;
  onFieldChange: (field: string, val: any) => void;
  onSave: () => void;
  onCancel: () => void;
  existingGroups: string[];
  lockGroup?: boolean;
}

export default function ParamMetaEditor({
  editingKey,
  form,
  onFieldChange,
  onSave,
  onCancel,
  existingGroups,
  lockGroup = false,
}: ParamMetaEditorProps) {
  const [newValInput, setNewValInput] = useState("");
  const [selSubKey, setSelSubKey] = useState<string>("");

  const addValueToForm = () => {
    const t = newValInput.trim();
    if (!t) return;
    let p: string | number;
    if (/^-?\d+$/.test(t)) p = parseInt(t, 10);
    else if (/^-?\d+\.\d+$/.test(t)) p = parseFloat(t);
    else p = t;
    const vals = form.values.includes(p) ? form.values : [...form.values, p];
    onFieldChange("values", vals);
    setNewValInput("");
  };

  return (
    <div className="mt-2 border cfg-bord--warn--a40 cfg-panel rounded p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="type-body font-mono cfg-warn">{editingKey} — PARAM METADATA</span>
        <button onClick={onCancel} className="cfg-mut hover:text-white transition-colors leading-none">✕</button>
      </div>

      {/* label row */}
      <div className="flex flex-col gap-0.5 mb-2">
        <span className="type-tiny font-mono cfg-mut">label</span>
        <input
          type="text"
          value={form.label}
          onChange={(e) => onFieldChange("label", e.target.value)}
          placeholder={editingKey}
          className="w-full bg-transparent border-b cfg-bord--a50 type-body font-mono text-white focus:outline-none px-1 py-0.5"
        />
      </div>

      {/* ptype + flag row */}
      <div className="flex gap-3 mb-2">
        <div className="flex flex-col gap-0.5">
          <span className="type-tiny font-mono cfg-mut">ptype</span>
          <select value={form.ptype}
            onChange={(e) => onFieldChange("ptype", e.target.value)}
            className="cfg-bord--a50 border cfg-bord type-body font-mono text-white px-1 py-0.5 focus:outline-none rounded">
            <option value="arg_select">arg_select</option>
            <option value="arg_select_double">arg_select_double</option>
            <option value="slider">slider</option>
            <option value="logic_only">logic_only</option>
            <option value="switch_onoff">switch_onoff</option>
            <option value="switch_inverted">switch_inverted</option>
             <option value="path_scanner">path_scanner</option>
           </select>
        </div>

        {form.ptype !== "logic_only" && (
          <div className="flex flex-col gap-0.5">
            <span className="type-tiny font-mono cfg-mut">flag</span>
            <input type="text" value={form.flag}
              onChange={(e) => onFieldChange("flag", e.target.value)}
              placeholder="-my-flag"
              className="w-32 bg-transparent border-b cfg-bord--a50 type-body font-mono text-white focus:outline-none px-1 py-0.5" />
          </div>
       )}
       </div>

        {/* ui_group row */}
        <div className="flex gap-3 mb-2 mt-2 pt-2 border-t cfg-bord--a30">
          <div className="flex flex-col gap-0.5 flex-1">
            <span className="type-tiny font-mono cfg-mut">group</span>
            <select
              disabled={lockGroup}
              title={lockGroup ? SYSTEM_CATALOG_PARAM_TOOLTIP : undefined}
              value={
                form.uiGroup === "__custom__" ||
                (form.uiGroup && !existingGroups.includes(form.uiGroup))
                  ? "__custom__"
                  : form.uiGroup || "__none__"
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom__") {
                  onFieldChange("uiGroup", "__custom__");
                } else if (v === "__none__") {
                  onFieldChange("uiGroup", "");
                  onFieldChange("customGroup", "");
                } else {
                  onFieldChange("uiGroup", v);
                  onFieldChange("customGroup", "");
                }
              }}
              className="w-full cfg-bord--a50 border focus:cfg-bord--acc--a40 type-body font-mono text-white px-1 py-0.5 focus:outline-none focus:cfg-bord--acc rounded disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="__none__">— No group (Feature Flags) —</option>
              {existingGroups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
              <option value="__custom__">✏ Custom...</option>
            </select>
            {(form.uiGroup === "__custom__" ||
              (form.uiGroup && !existingGroups.includes(form.uiGroup))) && (
              <input
                type="text"
                value={
                  form.uiGroup === "__custom__"
                    ? form.customGroup
                    : form.uiGroup
                }
                onChange={(e) => {
                  onFieldChange("uiGroup", "__custom__");
                  onFieldChange("customGroup", e.target.value);
                }}
                placeholder="New group name..."
                className="config-param-add-input bg-transparent border-b cfg-bord--warn--a30 type-body font-mono text-white focus:outline-none px-1 py-0.5 mt-1 placeholder:cfg-mut--a50"
              />
            )}
          </div>

          {form.ptype === "path_scanner" && (
            <div className="flex flex-col gap-0.5">
              <span className="type-tiny font-mono cfg-mut">pattern</span>
              <input type="text" value={form.pattern}
                onChange={(e) => onFieldChange("pattern", e.target.value)}
                placeholder="*mmproj*"
                className="w-24 bg-transparent border-b cfg-bord--a50 type-body font-mono text-white focus:outline-none px-1 py-0.5" />
            </div>
          )}
        </div>

      {/* values list + default */}
      <div className="mb-2">
        <span className="type-tiny font-mono cfg-mut mr-2">values:</span>
        {form.values.map((v, i) => (
          <span key={i} className={`inline-flex items-center gap-0.5 px-1 py-0.5 border type-label font-mono rounded-sm mr-1 mb-1 ${String(v) === String(form.defaultValue) ? "cfg-bord--acc--a70 cfg-fill--a20 cfg-acc" : "cfg-bord--a40 text-white"}`}>
            {String(v)}
            <button onClick={() => {
              const newVals = form.values.filter((_, idx) => idx !== i);
              // Also remove from subParams if exists
              const spCopy = { ...form.subParams };
              delete spCopy[String(v)];
              onFieldChange("subParams", spCopy);
              onFieldChange("values", newVals);
            }} className="cfg-dng--a50 hover:cfg-dng leading-none">×</button>
            <button onClick={() => onFieldChange("defaultValue", v)}
              title="Set as default" className={`leading-none ${String(v) === String(form.defaultValue) ? "cfg-acc" : "cfg-mut--a50 hover:cfg-acc"}`}>*</button>
          </span>
        ))}
        <input type="text" value={newValInput}
          onChange={(e) => setNewValInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addValueToForm(); } }}
          placeholder="+add"
          className="config-param-add-input w-16 bg-transparent border-b cfg-bord--a50 type-label font-mono text-white focus:outline-none px-1" />
        <button onClick={addValueToForm}
          disabled={!newValInput.trim()}
          className="type-tiny font-mono cfg-acc--a60 hover:cfg-acc transition-colors ml-1">+VAL</button>
      </div>

      {/* sub_params section — only for logic_only or when values have actual sub-params */}
      {(() => {
        const hasSubParams = Object.keys(form.subParams).some(k => form.subParams[k]?.trim());
        const showSection = form.ptype === "logic_only" || hasSubParams;
        if (!showSection) return null;
        return (
          <div className="border-t cfg-bord--a30 pt-2">
            <span className="type-tiny font-mono cfg-mut mr-2">sub-params:</span>
            {form.values.map(v => {
              const k = String(v);
              return (
                <div key={k} className="flex items-center gap-1 mb-1">
                  <button onClick={() => setSelSubKey(k)}
                    className={`type-label font-mono px-1 py-0.5 border rounded-sm ${selSubKey === k ? "cfg-bord--warn--a60 cfg-warn" : "cfg-bord--a40 text-white"}`}>
                    {k}
                  </button>
                  <input type="text"
                    value={form.subParams[k] || ""}
                    onChange={(e) => {
                      const sp = {...form.subParams};
                      if (e.target.value.trim()) sp[k] = e.target.value;
                      else delete sp[k];
                      onFieldChange("subParams", sp);
                    }}
                    placeholder="(no args)"
                    className="flex-1 bg-transparent border-b cfg-bord--a30 type-label font-mono text-white focus:outline-none px-1" />
                </div>
              );
            })}
          </div>
        );
      })()}

      <button onClick={onSave}
        className="mt-3 px-3 py-1 type-label font-mono border cfg-bord--acc--a60 cfg-fill--a20 cfg-acc hover:cfg-fill--a30 transition-colors">APPLY</button>
    </div>
  );
}
