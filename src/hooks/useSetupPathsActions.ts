import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dispatchAppEvent, dispatchNavigateConfig, EVENTS } from "../lib/events";
import type { ModelLibraryValidation } from "../lib/types";

export function useSetupPathsActions() {
  const [migrating, setMigrating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [needsBrowse, setNeedsBrowse] = useState(false);
  const [lmStudioDefaultPath, setLmStudioDefaultPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_lm_studio_default_path")
      .then((path) => {
        if (!cancelled) setLmStudioDefaultPath(path);
      })
      .catch(() => {
        if (!cancelled) setLmStudioDefaultPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openPaths = useCallback(() => {
    dispatchNavigateConfig({ subTab: "paths" });
  }, []);

  const browseModelLibrary = useCallback(async () => {
    setBrowsing(true);
    setActionError(null);
    try {
      const selected = await invoke<string | null>("open_folder_dialog", {
        title: "Select model library folder",
      });
      if (!selected) return;

      const validation = await invoke<ModelLibraryValidation>("validate_model_library", {
        path: selected,
      });
      if (!validation.exists) {
        setActionError("That folder does not exist.");
        setNeedsBrowse(true);
        return;
      }
      if (validation.ggufCount === 0) {
        setActionError(
          `No GGUF models found in ${validation.resolvedPath}. Pick a folder that contains your models.`,
        );
        setNeedsBrowse(true);
        return;
      }

      await invoke("add_model_path", { path: selected, label: null });
      setNeedsBrowse(false);
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (err) {
      const msg = typeof err === "string" ? err : "Could not add model folder.";
      setActionError(msg);
      setNeedsBrowse(true);
    } finally {
      setBrowsing(false);
    }
  }, []);

  const migrateFromLmStudio = useCallback(async () => {
    setMigrating(true);
    setActionError(null);
    setNeedsBrowse(false);
    try {
      const added = await invoke<boolean>("add_lmstudio_model_path");
      if (added) {
        setNeedsBrowse(false);
        dispatchAppEvent(EVENTS.modelPathsChanged);
      } else {
        setActionError("LM Studio folder is already linked.");
      }
    } catch (err) {
      const msg = typeof err === "string" ? err : "Could not link LM Studio models folder.";
      setActionError(msg);
      setNeedsBrowse(true);
    } finally {
      setMigrating(false);
    }
  }, []);

  const clearActionError = useCallback(() => setActionError(null), []);
  const reportActionError = useCallback((msg: string) => setActionError(msg), []);

  return {
    migrating,
    browsing,
    actionError,
    needsBrowse,
    lmStudioDefaultPath,
    openPaths,
    browseModelLibrary,
    migrateFromLmStudio,
    clearActionError,
    reportActionError,
  };
}