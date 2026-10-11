import type { CSSProperties, ReactNode } from "react";
import type { CatalogEntry, ObjectType } from "@/lib/api";
import { TYPE_COLORS, TYPE_SINGULAR } from "@/lib/theme";

export const DASH = "—";

/** "15.3647° N, 75.1240° E" */
export function fmtLatLon(lat: number, lon: number, digits = 2): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? "E" : "W"}`;
}

/** Where a closest approach happens: lat, lon and altitude, or a dash for records made before this was computed. */
export function fmtTcaPlace(c: { tca_lat_deg?: number; tca_lon_deg?: number; tca_alt_km?: number }): string {
  if (c.tca_lat_deg == null || c.tca_lon_deg == null || c.tca_alt_km == null) return DASH;
  return `${fmtLatLon(c.tca_lat_deg, c.tca_lon_deg)} · ${Math.round(c.tca_alt_km)} km`;
}

/** Glass panel. `drift` adds the slow idle float (paused on hover/focus, off for reduced motion). */
export function Glass({
  as: Tag = "div",
  children,
  className = "",
  drift = false,
  style,
}: {
  as?: "div" | "aside" | "section" | "footer" | "article";
  children: ReactNode;
  className?: string;
  drift?: boolean;
  style?: CSSProperties;
}) {
  return (
    <Tag className={`glass pointer-events-auto ${drift ? "drift" : ""} ${className}`} style={style}>
      {children}
    </Tag>
  );
}

/** Small muted label on the left, ivory Geist Mono value on the right. */
export function Row({ label, value, unit }: { label: ReactNode; value: ReactNode; unit?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px]">
      <span className="text-[14px] text-muted">{label}</span>
      <span className="text-right font-mono text-[15px] text-ivory">
        {value}
        {unit && <span className="ml-1 text-[14px] text-muted">{unit}</span>}
      </span>
    </div>
  );
}

/** Key figure: 28px+ number with a small label beneath. */
export function Stat({ value, label, unit }: { value: ReactNode; label: string; unit?: string }) {
  return (
    <div>
      <div className="font-mono text-[28px] leading-none text-ivory">
        {value}
        {unit && <span className="ml-1 text-[15px] text-muted">{unit}</span>}
      </div>
      <div className="mt-1.5 text-[14px] leading-tight text-muted">{label}</div>
    </div>
  );
}

export function ComingSoon({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border border-gold/40 px-2.5 py-px font-sans text-[14px] text-gold ${className}`}
    >
      Coming soon
    </span>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <h2 className="heading">{children}</h2>
      {aside}
    </div>
  );
}

/** Object-type pill: colour dot + label. Marks types that are not official Space-Track values. */
export function TypeBadge({
  type,
  source,
}: {
  type: ObjectType;
  source?: CatalogEntry["type_source"];
}) {
  const color = TYPE_COLORS[type];
  const note = source === "inferred" ? " (inferred)" : source === "pasted" ? " (pasted TLE)" : "";
  return (
    <span
      title={source === "space-track" ? "Official Space-Track OBJECT_TYPE" : note.trim() || undefined}
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/12 px-2 py-px font-sans text-[14px] text-ivory"
    >
      <span className="h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      {TYPE_SINGULAR[type]}
      {note && <span className="text-muted">{note}</span>}
    </span>
  );
}
