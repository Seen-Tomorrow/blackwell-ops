import { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react";
import { EVENTS } from "../lib/events";
import { useTauriListen } from "../hooks/useTauriListen";

interface EngineFault {
  message: string;
  kind?: string;
  alias?: string;
  slot?: number;
}

interface StatusBarCtx {
  totalParams: number;
  hiddenCount: number;
  onShowAll?: () => void;
  flashMessage: string | null;
  triggerFlash: (message: string) => void;
  /** Persistent engine fault; click ATTENTION to acknowledge. */
  attention: EngineFault | null;
  clearAttention: () => void;
}

const StatusContext = createContext<StatusBarCtx>({
  totalParams: 0,
  hiddenCount: 0,
  flashMessage: null,
  triggerFlash: () => {},
  attention: null,
  clearAttention: () => {},
});

export const StatusProvider: React.FC<{ value: any; children?: React.ReactNode }> = ({ value, children }) => {
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const [attention, setAttention] = useState<EngineFault | null>(null);

  useTauriListen<{ message?: string; kind?: string; alias?: string; slot?: number }>(
    "engine-fault",
    (payload) => {
      if (!payload?.message) return;
      setAttention({
        message: payload.message,
        kind: payload.kind,
        alias: payload.alias,
        slot: payload.slot,
      });
    },
  );

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
        setFlashMessage(`${detail.alias} launched @ :${detail.port}`);
        setAttention(null);
      }
    };

    const handleError = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string };
      if (detail?.message) {
        setFlashMessage(detail.message);
      }
    };

    window.addEventListener(EVENTS.launchSuccess, handleSuccess);
    window.addEventListener(EVENTS.launchError, handleError);

    return () => {
      window.removeEventListener(EVENTS.launchSuccess, handleSuccess);
      window.removeEventListener(EVENTS.launchError, handleError);
    };
  }, []);

  const triggerFlash = useCallback((message: string) => {
    setFlashMessage(message);
  }, []);

  const clearAttention = useCallback(() => {
    setAttention(null);
  }, []);

  // Merge flash state into provided value — memoized to prevent unnecessary re-renders of consumers
  const mergedValue = useMemo(
    () => ({ ...value, flashMessage, triggerFlash, attention, clearAttention }),
    [value, flashMessage, triggerFlash, attention, clearAttention]
  );

  return <StatusContext.Provider value={mergedValue}>{children}</StatusContext.Provider>;
};

export function useStatus() {
  return useContext(StatusContext);
}