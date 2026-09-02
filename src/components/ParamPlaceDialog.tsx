/**
 * "PLACE PARAM" dialog shown after adding a param from the catalog — pick the
 * target group or keep the default USER-ADDED-FROM-CATALOG. Pure presentational.
 */
export default function ParamPlaceDialog(props: ParamPlaceDialogProps) {
  const { open, paramKey, group, groupNames, onGroupChange, onClose, onConfirm } = props;
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-start justify-center pt-20" onClick={onClose}>
      <div
        className="config-form-panel rounded-sm w-full max-w-md mx-4 shadow-2xl border cfg-bord--a40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 config-section-bar flex items-center justify-between">
          <h2 className="type-sm font-mono theme-accent-text tracking-widest">PLACE PARAM</h2>
          <span className="type-label font-mono config-muted truncate max-w-[12rem]" title={paramKey ?? undefined}>
            {paramKey}
          </span>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="type-label font-mono cfg-mut--a70 leading-snug">
            Added from catalog. Default group is USER-ADDED-FROM-CATALOG — pick another group or keep it.
          </p>
          <label className="block">
            <span className="type-tiny font-mono tracking-wider uppercase cfg-mut--a50">Group</span>
            <select
              value={group}
              onChange={(e) => onGroupChange(e.target.value)}
              className="mt-1 w-full bg-black/40 border cfg-bord--a40 rounded-sm px-2 py-1.5 type-body font-mono cfg-acc focus:outline-none"
            >
              {groupNames.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="px-2 py-1 type-label font-mono cfg-mut hover:text-white" onClick={onClose}>
              Keep default
            </button>
            <button
              type="button"
              className="px-2.5 py-1 type-label font-mono rounded-sm border cfg-bord--acc--a40 cfg-acc hover:cfg-fill--a10"
              onClick={onConfirm}
            >
              Assign group
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface ParamPlaceDialogProps {
  /** `catalogPlaceKey != null` gates visibility. */
  open: boolean;
  /** Catalog param key being placed. */
  paramKey: string | null;
  /** Currently selected target group. */
  group: string;
  /** All existing group names (options). */
  groupNames: string[];
  onGroupChange: (g: string) => void;
  /** Close without assigning (keep default). */
  onClose: () => void;
  /** Assign the param to the selected group. */
  onConfirm: () => void;
}
