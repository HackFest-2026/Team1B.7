"use client";

import { useEffect, useRef, type CSSProperties } from "react";

export type Tab = "live" | "sentinel" | "fuel" | "model" | "about";
export type CatalogStatus = "loading" | "ok" | "error";
export type NavSize = { w: number; h: number };

/** Horizontal header padding on each side (px-6 desktop, px-4 narrow), counted in the overlap check. */
export const NAV_PAD_DESKTOP = 48;
export const NAV_PAD_NARROW = 32;
const COL_GAP = 24; // gap-6 between the header's grid columns
// Spacer column minimum = the logo's reserve minus what the header padding and column gap already provide.
const PAD_DESKTOP = NAV_PAD_DESKTOP / 2 + COL_GAP;
const PAD_NARROW = NAV_PAD_NARROW / 2 + COL_GAP;

const TABS: { id: Tab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "sentinel", label: "Sentinel" },
  { id: "fuel", label: "Fuel" },
  { id: "model", label: "Model" },
  { id: "about", label: "About" },
];

/** Very faint gold orbit behind a tab label; fades in (~18%) and slowly turns on hover/focus. */
function TabOrbit() {
  return (
    <span
      aria-hidden
      className="hover-fade pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-[0.18] group-focus-visible:opacity-[0.18]"
    >
      <span className="block h-[54px] w-[54px]" style={{ transform: "rotate(-14deg) scaleY(0.38) scaleX(1.5)" }}>
        <svg
          viewBox="0 0 100 100"
          className="orbit-spin-slow h-full w-full overflow-visible"
          style={{ filter: "drop-shadow(0 0 3px rgb(217 183 126 / 0.9))" }}
        >
          <circle cx="50" cy="50" r="48" fill="none" stroke="#D9B77E" strokeWidth="1.6" />
          <circle cx="98" cy="50" r="4" fill="#E8D3A8" />
        </svg>
      </span>
    </span>
  );
}

/**
 * Tabs centre, catalog count + data freshness right. The logo sits above the left column (BrandLogo), which reserves
 * at least `minLeft` px (logo + gap) so the tabs can never slide under it. `stacked` puts the tabs on their own row
 * below the logo (phones). The pill's measured size is reported to the layout through `onSize`.
 */
export function TopNav({
  tab,
  onTab,
  status,
  total,
  medianAge,
  fetchedAt,
  minLeft,
  stacked,
  stackTop,
  onSize,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  status: CatalogStatus;
  total: number;
  medianAge: string | null;
  fetchedAt: Date | null;
  minLeft: number;
  stacked: boolean;
  stackTop: number;
  onSize: (s: NavSize) => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const stackedRef = useRef(stacked);
  useEffect(() => {
    stackedRef.current = stacked;
  }, [stacked]);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      // While stacked the pill may be squeezed; keep the last natural width so the layout cannot oscillate.
      if (!stackedRef.current) onSize({ w: Math.ceil(r.width), h: Math.ceil(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onSize]);

  return (
    <header
      className={`pointer-events-none fixed inset-x-0 top-0 z-20 grid items-start gap-6 px-6 pt-6 max-[859px]:px-4 max-[859px]:pt-4 ${
        stacked ? "grid-cols-1" : "nav-grid"
      }`}
      style={
        stacked
          ? { paddingTop: stackTop }
          : ({ "--nav-min": `${Math.max(0, minLeft - PAD_DESKTOP)}px`, "--nav-min-narrow": `${Math.max(0, minLeft - PAD_NARROW)}px` } as CSSProperties)
      }
    >
      {!stacked && <div />}

      <nav
        ref={navRef}
        role="tablist"
        aria-label="Sections"
        className={`glass pointer-events-auto flex max-w-full gap-1 rounded-full px-2 py-1.5 ${stacked ? "justify-self-center" : "justify-self-center max-[859px]:justify-self-end"}`}
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => onTab(t.id)}
              className={`tab group relative rounded-full py-1.5 text-[15px] transition-colors duration-700 ease-soft ${stacked ? "px-3.5" : "px-5"} ${
                active ? "bg-white/[0.07] font-semibold text-gold" : "text-ivory hover:text-gold"
              }`}
            >
              <TabOrbit />
              <span className="relative">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <div className={`pointer-events-auto justify-self-end text-right max-[859px]:hidden ${stacked ? "hidden" : ""}`}>
        {status === "loading" && <span className="text-[15px]">Loading catalog</span>}
        {status === "error" && <span className="text-[15px] text-rose">Catalog unavailable</span>}
        {status === "ok" && (
          <div className="leading-tight">
            <div>
              <span className="font-mono text-[28px] text-ivory">{total.toLocaleString()}</span>
              <span className="ml-2 text-[14px] text-muted">objects</span>
            </div>
            <div className="mt-1 text-[14px] text-muted">
              TLE median age <span className="font-mono text-ivory">{medianAge ?? "—"}</span>
              {fetchedAt && (
                <>
                  <span className="mx-1.5">·</span>
                  loaded <span className="font-mono text-ivory">{fetchedAt.toISOString().slice(11, 16)} UTC</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
