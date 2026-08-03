// Inline sub-params editor for a single value (e.g. "-flag1 value1 ...").
// Extracted from ParamConfigPanel.

export interface SubParamsEditorTarget {
  paramKey: string;
  valueName: string;
}

interface SubParamsEditorProps {
  editingValue: SubParamsEditorTarget;
  subArgsText: Record<string, string>;
  onTextChange: (key: string, val: string) => void;
  onSave: () => void;
  onDelete: (paramKey: string, valueName: string) => void;
  onCancel: () => void;
}

export default function SubParamsEditor({
  editingValue,
  subArgsText,
  onTextChange,
  onSave,
  onDelete,
  onCancel,
}: SubParamsEditorProps) {
  const key = editingValue.paramKey + "::" + editingValue.valueName;
  return (
    <div className="flex items-start gap-2 p-2 mt-1 border border-yellow-400/30 bg-yellow-400/5 rounded">
      <span className="text-[10px] font-mono text-nv-green min-w-fit">{editingValue.valueName}</span>
      <input
        type="text"
        value={subArgsText[key] || ""}
        onChange={(e) => onTextChange(key, e.target.value)}
        placeholder="-flag1 value1 -flag2 value2 ..."
        className="flex-1 bg-transparent border-b border-yellow-400/30 text-[10px] font-mono text-white focus:outline-none px-1"
      />
      <button onClick={onSave}
        className="px-2 py-0.5 text-[9px] font-mono text-nv-green hover:text-white transition-colors">SAVE</button>
      <button onClick={() => onDelete(editingValue.paramKey, editingValue.valueName)}
        className="px-1 py-0.5 text-[9px] font-mono text-red-400/60 hover:text-red-400 transition-colors" title="Remove this sub-param entry">×</button>
      <button onClick={onCancel}
        className="text-[10px] font-mono text-stealth-muted hover:text-white transition-colors leading-none">✕</button>
    </div>
  );
}
