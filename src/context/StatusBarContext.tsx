import { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react";

export interface StatusBarCtx {
  totalParams: number;
  hiddenCount: number;
  onShowAll?: () => void;
  flashMessage: string | null;
  triggerFlash: (message: string) => void;
}

const StatusContext = createContext<StatusBarCtx>({
  totalParams: 0,
  hiddenCount: 0,
  flashMessage: null,
  triggerFlash: () => {},
});

export const StatusProvider: React.FC<{ value: any; children?: React.ReactNode }> = ({ value, children }) => {
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  // Auto-clear flash after 4 seconds
  useEffect(() => {
    if (!flashMessage) return;
    const timer = setTimeout(() => setFlashMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [flashMessage]);

  // Listen for launch events to show in status bar
  useEffect(() => {
    const handleSuccess = (e: Event) => {
      const detail = (e as CustomEvent).detail as { alias: string; port: number };
      if (detail?.alias && detail.port) {
        setFlashMessage(`${detail.alias} ignited @ :${detail.port}`);
      }
    };

    const handleError = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string };
      if (detail?.message) {
        setFlashMessage(detail.message);
      }
    };

    window.addEventListener("blackops-launch-success", handleSuccess);
    window.addEventListener("blackops-launch-error", handleError);

    return () => {
      window.removeEventListener("blackops-launch-success", handleSuccess);
      window.removeEventListener("blackops-launch-error", handleError);
    };
  }, []);

  const triggerFlash = useCallback((message: string) => {
    setFlashMessage(message);
  }, []);

  // Merge flash state into provided value — memoized to prevent unnecessary re-renders of consumers
  const mergedValue = useMemo(
    () => ({ ...value, flashMessage, triggerFlash }),
    [value, flashMessage, triggerFlash]
  );

  return <StatusContext.Provider value={mergedValue}>{children}</StatusContext.Provider>;
};

export function useStatus() {
  return useContext(StatusContext);
}