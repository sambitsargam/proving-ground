import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import "./toast.css";

interface Toast {
  id: number;
  text: string;
}

const ToastContext = createContext<(text: string) => void>(() => {});

/** Short confirmations, read out by screen readers through a polite live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const show = useCallback((text: string) => {
    next.current += 1;
    const id = next.current;
    setToasts((all) => [...all.slice(-2), { id, text }]);
    window.setTimeout(() => setToasts((all) => all.filter((toast) => toast.id !== id)), 2600);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <p key={toast.id} className="toast">
            <Icon name="check" size={16} />
            {toast.text}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}

/** Copies text and confirms with a toast. */
export function useCopy(): (text: string, confirmation?: string) => void {
  const toast = useToast();
  return (text, confirmation = "Copied to clipboard") => {
    navigator.clipboard?.writeText(text).then(
      () => toast(confirmation),
      () => toast("Copy failed. Select the text instead."),
    );
  };
}
