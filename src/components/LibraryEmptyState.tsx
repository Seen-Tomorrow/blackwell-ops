import { useSetupPathsActions } from "../hooks/useSetupPathsActions";
import { dispatchNavigateModelHub } from "../lib/events";

interface LibraryEmptyStateProps {
  /**
   * A configured path holds `.gguf` files, yet the catalog produced no usable
   * model — different failure from “no folder linked at all”, and the copy has
   * to say which one the user is looking at.
   */
  libraryLinked: boolean;
}

/**
 * OPERATIONS right pane when the catalog has no model to configure.
 *
 * This replaces a dead end: after first-run setup could be finished with an
 * empty library, the pane rendered “SELECT A MODEL” with nothing selectable and
 * no way forward. Every action that can produce a model lives here — the same
 * three verbs the setup wizard offers, so the recovery path is never hidden.
 */
export default function LibraryEmptyState({ libraryLinked }: LibraryEmptyStateProps) {
  const { migrating, browsing, actionError, browseModelLibrary, migrateFromLmStudio } =
    useSetupPathsActions();
  const busy = migrating || browsing;

  return (
    <div className="flex flex-col items-center justify-center h-full eng-empty font-mono">
      <div className="text-center config-empty-enter flex flex-col items-center gap-3 max-w-[430px]">
        <div className="text-3xl eng-empty__glyph" aria-hidden>
          ⬡
        </div>
        <p className="text-xs tracking-widest uppercase">NO MODEL TO CONFIGURE</p>
        <p className="type-label leading-relaxed opacity-50">
          {libraryLinked
            ? "Your library folder is linked, but it holds no launchable GGUF model."
            : "Link the folder that holds your GGUF models, or download one."}
        </p>

        <div className="eng-empty__actions">
          <button
            type="button"
            onClick={() => void migrateFromLmStudio()}
            disabled={busy}
            className="eng-empty__btn eng-empty__btn--cyan"
            title="Link the LM Studio models folder"
          >
            {migrating ? "LINKING…" : "MIGRATE FROM LM STUDIO"}
          </button>
          <button
            type="button"
            onClick={() => void browseModelLibrary()}
            disabled={busy}
            className="eng-empty__btn"
          >
            {browsing ? "BROWSING…" : "BROWSE FOR MODEL PATH"}
          </button>
          <button
            type="button"
            onClick={() => dispatchNavigateModelHub()}
            className="eng-empty__btn eng-empty__btn--primary"
            title="Open DOWNLOADS to fetch a model from Hugging Face"
          >
            DOWNLOAD MODELS
          </button>
        </div>

        {actionError && <p className="eng-empty__error">{actionError}</p>}
      </div>
    </div>
  );
}
