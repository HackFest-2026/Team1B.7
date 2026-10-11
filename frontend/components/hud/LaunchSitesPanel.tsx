"use client";

import { ArrowLeft, ExternalLink, Rocket } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { LaunchSiteRecord, LaunchSiteStatus } from "@/lib/api";
import { PALETTE } from "@/lib/theme";
import { EdgePanel } from "./EdgePanel";
import { DASH, fmtLatLon, Row, SectionTitle } from "./Glass";

const STATUS_LABEL: Record<LaunchSiteStatus, string> = {
  operational: "Operational",
  "under construction": "Under construction",
  inactive: "Inactive",
};

/** Lower-case and strip accents, so "andoya" finds Andøya and "alcantara" finds Alcântara. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/g, "o")
    .toLowerCase();

function matches(s: LaunchSiteRecord, q: string): boolean {
  if (!q) return true;
  const hay = fold([s.name, s.short_name, s.country, s.operator ?? "", ...s.aliases].join(" | "));
  return fold(q)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function StatusPill({ s }: { s: LaunchSiteStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/12 px-2 py-px text-[14px] text-ivory">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s === "operational" ? PALETTE.ice : s === "inactive" ? PALETTE.muted : PALETTE.amber }} />
      {STATUS_LABEL[s]}
    </span>
  );
}

function Dot({ indian }: { indian: boolean }) {
  return <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: indian ? PALETTE.gold : PALETTE.silver }} />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-1.5">
      <div className="text-[14px] text-muted">{label}</div>
      <div className="text-[15px] leading-snug text-ivory">{children}</div>
    </div>
  );
}

/** Info card: every dataset field, our computed physics facts, the source link and the fuel-calculator hand-off. */
function SiteCard({ s, onBack, onUseInFuel }: { s: LaunchSiteRecord; onBack: () => void; onUseInFuel: (id: string) => void }) {
  return (
    <div>
      <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-gold">
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} /> All sites
      </button>
      <div className="flex items-start gap-2">
        <Dot indian={s.indian} />
        <div className="min-w-0">
          <h3 className="font-serif text-[22px] font-semibold leading-tight">{s.name}</h3>
          <div className="mt-0.5 text-[15px] text-muted">
            {s.short_name} · {s.country}
          </div>
        </div>
      </div>
      <div className="mt-2">
        <StatusPill s={s.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-white/[0.03] px-3 py-2.5">
        <div>
          <div className="font-mono text-[22px] leading-none text-ivory">
            {s.physics.v_rot_kms.toFixed(3)}
            <span className="ml-1 text-[14px] text-muted">km/s</span>
          </div>
          <div className="mt-1 text-[14px] leading-tight text-muted">Earth-rotation boost (due east)</div>
        </div>
        <div>
          <div className="font-mono text-[22px] leading-none text-ivory">
            {s.physics.min_inclination_deg.toFixed(2)}
            <span className="ml-0.5 text-[14px] text-muted">°</span>
          </div>
          <div className="mt-1 text-[14px] leading-tight text-muted">Lowest inclination, direct launch</div>
        </div>
        <p className="col-span-2 text-[14px] leading-snug text-muted">Computed: 0.4651 · cos(latitude) km/s; lowest direct inclination = |latitude|.</p>
      </div>

      <div className="mt-2">
        <Row label="Operator" value={<span className="font-sans">{s.operator ?? DASH}</span>} />
        <Field label="Coordinates">
          <span className="font-mono">{fmtLatLon(s.lat, s.lon, 3)}</span>
          {s.coord_approx && <span className="ml-1.5 text-[14px] text-muted">approx.</span>}
        </Field>
        <p className="text-[14px] leading-snug text-muted">
          {s.coord_note} Cross-checked with OpenStreetMap: <span className="font-mono">{s.coord_check.distance_km.toFixed(1)} km</span> apart.
        </p>
        <Field label="Launch pads">{s.launch_pads ?? DASH}</Field>
        <Field label="Rockets launched">{s.rockets.length ? s.rockets.join(", ") : DASH}</Field>
        <Field label="First orbital launch">
          {s.first_orbital_launch_year != null ? <span className="font-mono">{s.first_orbital_launch_year}</span> : "None yet"}
          {s.first_orbital_note && <span className="block text-[14px] text-muted">{s.first_orbital_note}</span>}
        </Field>
        {s.notable_missions.length > 0 && (
          <Field label="Notable missions">
            <ul className="list-disc space-y-0.5 pl-4">
              {s.notable_missions.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Field>
        )}
        {s.why && <Field label="Why this location">{s.why}</Field>}
      </div>

      <button type="button" className="quiet-btn primary mt-3" onClick={() => onUseInFuel(s.id)}>
        Use in fuel calculator
      </button>

      <div className="mt-3 space-y-1 text-[14px]">
        <div className="text-muted">Source</div>
        {s.sources.map((u) => (
          <a key={u} href={u} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 break-all text-ivory hover:text-gold">
            <ExternalLink className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {decodeURIComponent(u.replace(/^https:\/\/(www\.)?/, ""))}
          </a>
        ))}
        {s.official_url && (
          <a href={s.official_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 break-all text-ivory hover:text-gold">
            <ExternalLink className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            Operator: {s.official_url.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "")}
          </a>
        )}
      </div>
    </div>
  );
}

/** Right edge panel "Launch sites": globe layer toggle, search + filters, list, and the info card of the picked site. */
export function LaunchSitesPanel({
  sites,
  error,
  showLayer,
  onShowLayer,
  selectedId,
  onSelect,
  onUseInFuel,
  open,
  onToggle,
  top,
  panelTop,
}: {
  sites: LaunchSiteRecord[] | null;
  error: string | null;
  showLayer: boolean;
  onShowLayer: (v: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUseInFuel: (id: string) => void;
  open: boolean;
  onToggle: () => void;
  top: number;
  panelTop: number;
}) {
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState<LaunchSiteStatus | "">("");
  const countries = useMemo(() => [...new Set((sites ?? []).map((s) => s.country))].sort(), [sites]);
  const shown = useMemo(
    () =>
      (sites ?? [])
        .filter((s) => (!country || s.country === country) && (!status || s.status === status) && matches(s, q))
        .sort((a, b) => Number(b.indian) - Number(a.indian) || a.name.localeCompare(b.name)),
    [sites, q, country, status],
  );
  const selected = selectedId ? (sites ?? []).find((s) => s.id === selectedId) ?? null : null;

  return (
    <EdgePanel side="right" label="Launch sites" icon={Rocket} open={open} onToggle={onToggle} top={top} panelTop={panelTop}>
      {selected ? (
        <SiteCard s={selected} onBack={() => onSelect(null)} onUseInFuel={onUseInFuel} />
      ) : (
        <>
          <SectionTitle
            aside={
              <label className="flex cursor-pointer items-center gap-2 text-[14px] text-ivory">
                <input type="checkbox" checked={showLayer} onChange={(e) => onShowLayer(e.target.checked)} /> On globe
              </label>
            }
          >
            Launch sites
          </SectionTitle>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, country, operator (e.g. SHAR, ISRO)"
            aria-label="Search launch sites"
            className="field"
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select value={country} onChange={(e) => setCountry(e.target.value)} className="field px-2" aria-label="Filter by country">
              <option value="">All countries</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value as LaunchSiteStatus | "")} className="field px-2" aria-label="Filter by status">
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABEL) as LaunchSiteStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="mt-2 text-[14px] text-rose">{error}</p>}
          {!sites && !error && <p className="mt-2 text-[14px] text-muted">Loading…</p>}
          {sites && (
            <p className="mt-2 text-[14px] text-muted">
              <span className="font-mono text-ivory">{shown.length}</span> of <span className="font-mono">{sites.length}</span> sites. Gold: India.
            </p>
          )}
          <ul className="mt-1.5 space-y-1">
            {shown.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-500 hover:bg-white/[0.05]"
                >
                  <Dot indian={s.indian} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-ivory">{s.name}</span>
                    <span className="block text-[14px] text-muted">
                      {s.country} · {STATUS_LABEL[s.status]}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[14px] text-muted">{Math.abs(s.lat).toFixed(1)}°{s.lat >= 0 ? "N" : "S"}</span>
                </button>
              </li>
            ))}
          </ul>
          {sites && shown.length === 0 && <p className="mt-2 text-[14px]">No site matches.</p>}
        </>
      )}
    </EdgePanel>
  );
}
