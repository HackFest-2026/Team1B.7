"use client";

import { useEffect } from "react";
import { Glass } from "./Glass";

export interface ToastMsg {
  id: number;
  text: string;
}

const VISIBLE_MS = 6500;

/** Subtle, auto-dismissing status message above the time dock. */
export function Toast({ toast, onDone }: { toast: ToastMsg | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDone, VISIBLE_MS);
    return () => clearTimeout(t);
  }, [toast, onDone]);

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[108px] z-30 flex justify-center px-4">
      {toast && (
        <Glass key={toast.id} className="fade-in pointer-events-auto flex items-center gap-2.5 rounded-full px-4 py-2 text-[15px]" style={{ borderRadius: 999 }}>
          <span className="h-2 w-2 shrink-0 rounded-full bg-rose shadow-[0_0_8px_var(--color-rose)]" />
          {toast.text}
        </Glass>
      )}
    </div>
  );
}
