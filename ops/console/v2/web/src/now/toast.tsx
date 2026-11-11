// Toasts. One module-level store so any action anywhere on the tab can report a failure
// without threading a callback through five components, read with useSyncExternalStore so
// the tree stays consistent and server rendering has a stable empty snapshot.
//
// Only failures and short confirmations go here. Nothing important is ONLY in a toast:
// every action that matters also moves the card, the row or the list it belongs to.

import { useEffect, useSyncExternalStore } from "react";
import { Button, cx } from "../ui/primitives";

export type ToastTone = "error" | "info";

export interface Toast {
  id: string;
  tone: ToastTone;
  text: string;
  at: number;
}

const TTL_MS: Record<ToastTone, number> = { error: 12_000, info: 4_000 };
const MAX_TOASTS = 4;

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit(next: Toast[]): void {
  toasts = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Toast[] {
  return toasts;
}

const EMPTY: Toast[] = [];

function serverSnapshot(): Toast[] {
  return EMPTY;
}

export function pushToast(tone: ToastTone, text: string): string {
  seq += 1;
  const id = `t${seq}`;
  const toast: Toast = { id, tone, text: text.slice(0, 400), at: Date.now() };
  emit([toast, ...toasts].slice(0, MAX_TOASTS));
  return id;
}

export function toastError(text: string): string {
  return pushToast("error", text);
}

export function toastInfo(text: string): string {
  return pushToast("info", text);
}

export function dismissToast(id: string): void {
  emit(toasts.filter((toast) => toast.id !== id));
}

/** Test seam: drop everything without waiting for the timers. */
export function clearToasts(): void {
  emit([]);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export function ToastHost() {
  const items = useToasts();

  useEffect(() => {
    if (items.length === 0) return;
    const timers = items.map((toast) =>
      window.setTimeout(() => dismissToast(toast.id), Math.max(1000, toast.at + TTL_MS[toast.tone] - Date.now())),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div
      className="fixed inset-x-3 bottom-20 z-50 flex flex-col gap-1.5 md:inset-x-auto md:right-4 md:bottom-4 md:w-[min(420px,90vw)]"
      role="status"
      aria-live="polite"
    >
      {items.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            "flex items-start gap-2 rounded-sub border bg-panel px-3 py-2 text-[12px] shadow-card",
            toast.tone === "error" ? "border-bad text-bad" : "border-line text-ink",
          )}
        >
          <span className="min-w-0 flex-1 break-words">{toast.text}</span>
          <Button size="sm" variant="ghost" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
            close
          </Button>
        </div>
      ))}
    </div>
  );
}
