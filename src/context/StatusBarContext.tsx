import { createContext, useContext, useState, useCallback, useEffect } from "react";

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
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { alias: string; port: number };
      if (detail?.alias && detail.port) {
        setFlashMessage(`${detail.alias} ignited @ :${detail.port}`);
      }
    };
    window.addEventListener("blackops-launch-success", handler);
    return () => window.removeEventListener("blackops-launch-success", handler);
  }, []);

  const triggerFlash = useCallback((message: string) => {
    setFlashMessage(message);
  }, []);

  // Merge flash state into provided value
  const mergedValue = { ...value, flashMessage, triggerFlash };

  return <StatusContext.Provider value={mergedValue}>{children}</StatusContext.Provider>;
};

export function useStatus() {
  return useContext(StatusContext);
}
