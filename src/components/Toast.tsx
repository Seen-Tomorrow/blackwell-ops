import { useState, useEffect, useCallback } from "react";

export interface ToastData {
  id: number;
  message: string;
  type: "success" | "error";
  duration?: number;
}

let toastIdCounter = 0;

interface ToastProviderProps {
  children: React.ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const addToast = useCallback((message: string, type: "success" | "error", duration = 3000) => {
    const id = ++toastIdCounter;
    setToasts(prev => [...prev, { id, message, type, duration }]);
  }, []);

  // Listen for launch events from EngineConfigPanel
  useEffect(() => {
    const handleLaunchSuccess = (e: Event) => {
      const detail = (e as CustomEvent).detail as { alias: string; port: number };
      if (detail?.alias && detail.port) {
        addToast(`${detail.alias} ignited @ :${detail.port}`, "success");
      }
    };

    const handleLaunchError = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string };
      if (detail?.message) {
        // Strip any remaining ANSI codes that slipped through
        const clean = detail.message.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\[[0-9;]+[A-Za-z]/g, "").trim();
        addToast(clean || detail.message, "error", 6000);
      }
    };

    window.addEventListener("blackops-launch-success", handleLaunchSuccess);
    window.addEventListener("blackops-launch-error", handleLaunchError);

    return () => {
      window.removeEventListener("blackops-launch-success", handleLaunchSuccess);
      window.removeEventListener("blackops-launch-error", handleLaunchError);
    };
  }, [addToast]);

  // Auto-remove toasts after duration
  useEffect(() => {
    if (toasts.length === 0) return;

    const timers = toasts.map(toast =>
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toast.id));
      }, toast.duration || 3000)
    );

    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts]);

  // Expose addToast globally for other components to use
  useEffect(() => {
    (window as any).__blackopsToasts = { addToast };
    return () => { delete (window as any).__blackopsToasts; };
  }, [addToast]);

  return (
    <>
      {children}
      <div className="toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast-item ${toast.type}`}>
            <div>{toast.message}</div>
            <div className="toast-progress" style={{ animationDuration: `${toast.duration || 3000}ms` }} />
          </div>
        ))}
      </div>
    </>
  );
}
