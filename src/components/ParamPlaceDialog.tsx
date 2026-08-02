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
        className="config-form-panel rounded-sm w-full max-w-md mx-4 shadow-2xl border border-stealth-border/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 config-section-bar flex items-center justify-between">
          <h2 className="text-[11px] font-mono theme-accent-text tracking-widest">PLACE PARAM</h2>
          <span className="text-[9px] font-mono config-muted truncate max-w-[12rem]" title={paramKey ?? undefined}>
            {paramKey}
          </span>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-[9px] font-mono text-stealth-muted/70 leading-snug">
            Added from catalog. Default group is USER-ADDED-FROM-CATALOG — pick another group or keep it.
          </p>
          <label className="block">
            <span className="text-[8px] font-mono tracking-wider uppercase text-stealth-muted/50">Group</span>
            <select
              value={group}
              onChange={(e) => onGroupChange(e.target.value)}
              className="mt-1 w-full bg-black/40 border border-stealth-border/40 rounded-sm px-2 py-1.5 text-[10px] font-mono text-nv-green focus:outline-none"
            >
              {groupNames.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="px-2 py-1 text-[9px] font-mono text-stealth-muted hover:text-white" onClick={onClose}>
              Keep default
            </button>
            <button
              type="button"
              className="px-2.5 py-1 text-[9px] font-mono rounded-sm border border-nv-green/40 text-nv-green hover:bg-nv-green/10"
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
