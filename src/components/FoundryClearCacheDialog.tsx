import { useEffect } from "react";
import { createPortal } from "react-dom";

interface FoundryClearCacheDialogProps {
  open: boolean;
  kind: "tree" | "sccache";
  providerLabel: string;
  providerId: string;
  profile: string;
  sizeLabel: string;
  workTotalLabel: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Small in-app confirmation for clearing either Foundry cache.
 *
 * `tree` deletes the retained `work/build-{profile}` directory; `sccache` deletes the
 * shared object cache only. Native WebView2 dialogs ignore the app theme, so this stays
 * an in-app panel and keeps the two caches explicitly separate.
 */
export default function FoundryClearCacheDialog({
  open,
  kind,
  providerLabel,
  providerId,
  profile,
  sizeLabel,
  workTotalLabel,
  busy,
  error,
  onCancel,
  onConfirm,
}: FoundryClearCacheDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const isSccache = kind === "sccache";
  const title = isSccache ? "CLEAR OBJECT CACHE" : "CLEAR BUILD TREE";
  const confirmLabel = isSccache ? "CLEAR CACHE" : "CLEAR TREE";
  const keepLabel = isSccache ? "KEEP CACHE" : "KEEP TREE";

  // Portal to body: on the FOUNDRY page this component sits inside the app's
  // transform-zoomed main frame, and a `position: fixed` child there would be
  // positioned/scaled against that transformed ancestor instead of the viewport.
  return createPortal(
    <div
      className="fnd-cache-dialog-scrim"
      role="presentation"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        className="fnd-cache-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fnd-clear-tree-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="fnd-cache-dialog__header" id="fnd-clear-tree-title">
          <span aria-hidden>⚠</span> {title}
        </header>

        <div className="fnd-cache-dialog__body">
          <p className="fnd-cache-dialog__target">
            {providerLabel || providerId} <span aria-hidden>·</span> {profile.toUpperCase()}
          </p>
          {isSccache ? (
            <>
              <p className="fnd-cache-dialog__line">
                Delete the shared sccache objects
                {" "}— <span className="fnd-cache-dialog__size">{sizeLabel}</span>
              </p>
              <p className="fnd-cache-dialog__meta">
                Used by every Foundry build, not just this engine.
              </p>
              <p className="fnd-cache-dialog__note">
                The <strong>build tree stays</strong>. sccache stops while the folder is
                removed, then starts again on the next build and refills as needed.
              </p>
            </>
          ) : (
            <>
              <p className="fnd-cache-dialog__line">
                Delete <span className="fnd-cache-dialog__path">work/build-{profile}</span>
                {" "}— <span className="fnd-cache-dialog__size">{sizeLabel}</span>
              </p>
              <p className="fnd-cache-dialog__meta">
                All profiles currently use {workTotalLabel} under <span className="fnd-cache-dialog__path">work/</span>.
              </p>
              <p className="fnd-cache-dialog__note">
                The next build configures and compiles from scratch. The <strong>sccache object cache is not touched</strong>.
                {" "}This can take a few seconds on a large tree.
              </p>
            </>
          )}
          {error && <p className="fnd-cache-dialog__error" role="alert">{error}</p>}
        </div>

        <footer className="fnd-cache-dialog__footer">
          <button
            type="button"
            className="fnd-cache-dialog__btn"
            onClick={onCancel}
            disabled={busy}
            autoFocus
          >
            {keepLabel}
          </button>
          <button
            type="button"
            className="fnd-cache-dialog__btn fnd-cache-dialog__btn--danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "CLEARING…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
