"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CircleAlert, CircleCheck } from "lucide-react";

type Tone = "success" | "error";
type Toast = { id: number; tone: Tone; message: string };
type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DURATION_MS = 4500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const active = timers.current;
    return () => active.forEach(clearTimeout);
  }, []);

  const push = useCallback((tone: Tone, message: string) => {
    const id = ++nextId.current;
    setToasts((list) => [...list, { id, tone, message }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((list) => list.filter((t) => t.id !== id));
    }, DURATION_MS);
    timers.current.add(timer);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-24 z-50 flex flex-col items-center gap-2 md:inset-x-auto md:bottom-6 md:right-6 md:items-end"
      >
        {toasts.map((t) => {
          const Icon = t.tone === "success" ? CircleCheck : CircleAlert;
          return (
            <div
              key={t.id}
              className="flex w-full max-w-sm animate-sheet items-start gap-3 rounded-xl border border-line-strong bg-raised px-4 py-3 text-sm shadow-2xl"
            >
              <Icon
                aria-hidden
                className={`mt-0.5 h-4 w-4 shrink-0 ${t.tone === "success" ? "text-positive" : "text-fg"}`}
              />
              <span>{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast precisa de ToastProvider");
  return api;
}
