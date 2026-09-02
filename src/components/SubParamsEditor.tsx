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
    <div className="flex items-start gap-2 p-2 mt-1 border cfg-bord--warn--a30 cfg-fill--warn--a5 rounded">
      <span className="type-body font-mono cfg-acc min-w-fit">{editingValue.valueName}</span>
      <input
        type="text"
        value={subArgsText[key] || ""}
        onChange={(e) => onTextChange(key, e.target.value)}
        placeholder="-flag1 value1 -flag2 value2 ..."
        className="flex-1 bg-transparent border-b cfg-bord--warn--a30 type-body font-mono text-white focus:outline-none px-1"
      />
      <button onClick={onSave}
        className="px-2 py-0.5 type-label font-mono cfg-acc hover:text-white transition-colors">SAVE</button>
      <button onClick={() => onDelete(editingValue.paramKey, editingValue.valueName)}
        className="px-1 py-0.5 type-label font-mono cfg-dng--a60 hover:cfg-dng transition-colors" title="Remove this sub-param entry">×</button>
      <button onClick={onCancel}
        className="type-body font-mono cfg-mut hover:text-white transition-colors leading-none">✕</button>
    </div>
  );
}
