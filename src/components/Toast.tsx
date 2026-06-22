import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { EVENTS } from "../lib/events";

export interface ToastData {
  id: number;
  message: string;
  type: "success" | "error";
  duration?: number;
}

let toastIdCounter = 0;

type ToastAnchorRegistrar = (el: HTMLElement | null) => void;

const ToastAnchorContext = createContext<ToastAnchorRegistrar | null>(null);

interface ToastProviderProps {
  children: React.ReactNode;
}

function ToastViewport({ toasts, inline }: { toasts: ToastData[]; inline: boolean }) {
  return (
    <div className={`toast-container${inline ? " toast-container--inline" : ""}`}>
      {toasts.map(toast => (
        <div key={toast.id} className={`toast-item ${toast.type}`} title={toast.message}>
          <div className="toast-item__message">{toast.message}</div>
          <div className="toast-progress" style={{ animationDuration: `${toast.duration || 3000}ms` }} />
        </div>
      ))}
    </div>
  );
}

export function ToastAnchor({ className }: { className?: string }) {
  const registerAnchor = useContext(ToastAnchorContext);

  const ref = useCallback((node: HTMLDivElement | null) => {
    registerAnchor?.(node);
  }, [registerAnchor]);

  return (
    <div
      ref={ref}
      className={className}
      aria-live="polite"
      aria-label="Launch notifications"
    />
  );
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const expiryTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const addToast = useCallback((message: string, type: "success" | "error", duration?: number) => {
    const defaultDuration = type === "error" ? 8000 : 5000;
    const id = ++toastIdCounter;
    const toastDuration = duration || defaultDuration;
    setToasts(prev => [{ id, message, type, duration: toastDuration }, ...prev]);

    const timer = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      expiryTimersRef.current.delete(id);
    }, toastDuration);
    expiryTimersRef.current.set(id, timer);
  }, []);

  const registerAnchor = useCallback((el: HTMLElement | null) => {
    setAnchorEl(el);
  }, []);

  useEffect(() => {
    const handleLaunchSuccess = (e: Event) => {
      const detail = (e as CustomEvent).detail as { alias: string; port: number };
      if (detail?.alias && detail.port) {
        addToast(`${detail.alias} started @ :${detail.port}`, "success");
      }
    };

    const handleLaunchError = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string };
      if (detail?.message) {
        const clean = detail.message.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\[[0-9;]+[A-Za-z]/g, "").trim();
        addToast(clean || detail.message, "error", 6000);
      }
    };

    window.addEventListener(EVENTS.launchSuccess, handleLaunchSuccess);
    window.addEventListener(EVENTS.launchError, handleLaunchError);

    return () => {
      window.removeEventListener(EVENTS.launchSuccess, handleLaunchSuccess);
      window.removeEventListener(EVENTS.launchError, handleLaunchError);
    };
  }, [addToast]);

  useEffect(() => () => {
    for (const timer of expiryTimersRef.current.values()) clearTimeout(timer);
    expiryTimersRef.current.clear();
  }, []);

  useEffect(() => {
    window.__blackopsToasts = { addToast };
    return () => { window.__blackopsToasts = undefined; };
  }, [addToast]);

  const viewport = <ToastViewport toasts={toasts} inline={anchorEl !== null} />;

  return (
    <ToastAnchorContext.Provider value={registerAnchor}>
      {children}
      {anchorEl ? createPortal(viewport, anchorEl) : null}
    </ToastAnchorContext.Provider>
  );
}