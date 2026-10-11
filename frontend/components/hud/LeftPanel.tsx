"use client";

import { ChevronDown, Gauge, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ApiError,
  OBJECT_TYPES,
  fetchPasses,
  objectType,
  type CatalogEntry,
  type ObjectType,
  type PassesResponse,
} from "@/lib/api";
import {
  R_EARTH_KM,
  assumedSigmaKm,
  inclinationDeg,
  parsePastedTle,
  periodMinutes,
  positionAt,
  toSatrec,
} from "@/lib/orbit";
import { TYPE_COLORS, TYPE_LABELS } from "@/lib/theme";
import type { LayerVisibility } from "../scene/ObjectField";
import type { Observer } from "@/lib/observer";
import { EdgePanel } from "./EdgePanel";
import { DASH, Row, SectionTitle, Stat, TypeBadge } from "./Glass";

const GROUP_LABELS: Record<string, string> = {
  "space-track": "Space-Track on-orbit catalog",
  lookup: "Looked up by NORAD ID",
  pasted: "Pasted TLE",
  stations: "CelesTrak: space stations",
  active: "CelesTrak: active satellites",
  "cosmos-1408-debris": "Cosmos 1408 ASAT test, 2021",
  "fengyun-1c-debris": "Fengyun-1C ASAT test, 2007",
  "iridium-33-debris": "Iridium 33 collision, 2009",
  "cosmos-2251-debris": "Cosmos 2251 collision, 2009",
};

const SOURCE_LABELS: Record<string, string> = {
  "space-track": "Space-Track",
  celestrak: "CelesTrak (fallback)",
  "celestrak-sample": "Offline snapshot (fallback)",
};

const MAX_RESULTS = 6;
const STALE_TLE_DAYS = 30;

const fmtUtc = (iso: string) => iso.slice(0, 16).replace("T", " ");
const fmtHm = (iso: string) => iso.slice(11, 16);

function Stats({
  now,
  total,
  medianAge,
  source,
  fps,
}: {
  now: Date | null;
  total: number;
  medianAge: string | null;
  source: string | null;
  fps: number | null;
}) {
  return (
    <section>
      <div className="font-mono text-[15px] text-ivory">
        {now ? now.toISOString().slice(0, 19).replace("T", " ") : DASH}
        <span className="ml-1.5 text-[14px] text-muted">UTC (simulated)</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
        <Stat value={total > 0 ? total.toLocaleString() : DASH} label="Objects tracked" />
        <Stat value={medianAge ?? DASH} label="Median TLE age" />
        <Stat value={fps !== null ? Math.round(fps) : DASH} label="Frames per second" />
        <div>
          <div className="font-sans text-[17px] font-semibold leading-tight text-ivory">{source ?? DASH}</div>
          <div className="mt-1.5 text-[14px] leading-tight text-muted">Catalog source</div>
        </div>
      </div>
    </section>
  );
}

function Search({
  catalog,
  onSelect,
  onLookup,
}: {
  catalog: CatalogEntry[];
  onSelect: (norad: number) => void;
  onLookup: (norad: number) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [lookup, setLookup] = useState<{ state: "idle" | "loading" | "error"; msg?: string }>({ state: "idle" });
  const trimmed = q.trim();
  const asNorad = /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : null;

  const results = useMemo(() => {
    const s = trimmed.toUpperCase();
    if (s.length < 2 && asNorad === null) return [];
    return catalog.filter((c) => c.name.toUpperCase().includes(s) || String(c.norad) === s).slice(0, MAX_RESULTS);
  }, [trimmed, asNorad, catalog]);

  const runLookup = async (norad: number) => {
    setLookup({ state: "loading" });
    try {
      await onLookup(norad);
      setLookup({ state: "idle" });
    } catch (e) {
      setLookup({ state: "error", msg: e instanceof ApiError ? e.message : "Lookup failed." });
    }
  };

  return (
    <div>
      <label htmlFor="object-search" className="sr-only">
        Find an object by name or NORAD ID
      </label>
      <input
        id="object-search"
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setLookup({ state: "idle" });
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (results[0]) onSelect(results[0].norad);
          else if (asNorad !== null) void runLookup(asNorad);
        }}
        placeholder="Name or any NORAD ID"
        autoComplete="off"
        className="field"
      />
      {(trimmed.length >= 2 || asNorad !== null) && (
        <ul className="mt-1.5">
          {results.map((c) => (
            <li key={c.norad}>
              <button
                type="button"
                onClick={() => onSelect(c.norad)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[15px] transition-colors duration-500 hover:bg-white/[0.05] hover:text-gold"
              >
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <TypeBadge type={objectType(c)} />
                <span className="font-mono text-[14px] text-muted">{c.norad}</span>
              </button>
            </li>
          ))}
          {asNorad !== null && !results.some((r) => r.norad === asNorad) && (
            <li>
              <button
                type="button"
                onClick={() => void runLookup(asNorad)}
                disabled={lookup.state === "loading"}
                className="quiet-btn mt-1 inline-flex items-center gap-2"
              >
                {lookup.state === "loading" && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                Look up NORAD {asNorad}
              </button>
            </li>
          )}
          {results.length === 0 && asNorad === null && (
            <li className="px-1 py-1 text-[14px] text-muted">No match in the loaded catalog. Try a NORAD ID.</li>
          )}
        </ul>
      )}
      {lookup.state === "error" && <p className="mt-1.5 text-[14px] text-rose">{lookup.msg}</p>}
    </div>
  );
}

function Legend({
  counts,
  layers,
  onToggle,
  inferred,
}: {
  counts: Record<ObjectType, number>;
  layers: LayerVisibility;
  onToggle: (t: ObjectType) => void;
  inferred: boolean;
}) {
  return (
    <div className="mt-3">
      {OBJECT_TYPES.map((t) => (
        <label key={t} className="flex cursor-pointer items-center gap-3 py-[3px] text-[15px]">
          <input type="checkbox" checked={layers[t]} onChange={() => onToggle(t)} className="sr-only" />
          <span
            className="h-2.5 w-2.5 rounded-full transition-opacity duration-700 motion-reduce:transition-none"
            style={{ background: TYPE_COLORS[t], boxShadow: `0 0 8px ${TYPE_COLORS[t]}`, opacity: layers[t] ? 1 : 0.2 }}
          />
          <span className={`transition-opacity duration-700 ${layers[t] ? "opacity-100" : "opacity-50"}`}>
            {TYPE_LABELS[t]}
          </span>
          <span className="ml-auto font-mono text-[15px]">{counts[t].toLocaleString()}</span>
        </label>
      ))}
      <p className="mt-1 text-[14px] text-muted">
        {inferred ? "Types inferred from names (fallback source)." : "Official Space-Track OBJECT_TYPE."} Click to show or hide.
      </p>
    </div>
  );
}

function PasteTle({ onAdd }: { onAdd: (entry: CatalogEntry) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "error" | "warn" | "ok"; text: string } | null>(null);

  const submit = () => {
    try {
      const parsed = parsePastedTle(text, new Date());
      onAdd(parsed.entry);
      setMsg(
        parsed.ageDays > STALE_TLE_DAYS
          ? {
              kind: "warn",
              text: `Added, but the epoch (${parsed.epoch.toISOString().slice(0, 10)}) is ${parsed.ageDays.toFixed(0)} days old. SGP4 positions this far from epoch can be off by many kilometres.`,
            }
          : { kind: "ok", text: `Added ${parsed.entry.name} (NORAD ${parsed.entry.norad}).` },
      );
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left text-[15px] transition-colors duration-500 hover:text-gold"
      >
        Paste a TLE
        <ChevronDown className={`h-4 w-4 transition-transform duration-500 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2">
          <label htmlFor="tle-input" className="sr-only">
            Two-line element set, optionally with a name line
          </label>
          <textarea
            id="tle-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={"ISS (ZARYA)\n1 25544U 98067A   ...\n2 25544  51.6...."}
            className="field resize-y font-mono text-[13.5px] leading-snug"
          />
          <button type="button" onClick={submit} disabled={!text.trim()} className="quiet-btn primary mt-2">
            Add to globe
          </button>
          {msg && (
            <p className={`mt-1.5 text-[14px] ${msg.kind === "error" ? "text-rose" : msg.kind === "warn" ? "text-amber" : "text-ivory"}`}>
              {msg.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

type PassState =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "error"; msg: string }
  | { s: "ok"; data: PassesResponse };

function VisiblePasses({ norad, observer }: { norad: number; observer: Observer }) {
  // Keyed by object + observer so a different selection or location starts fresh.
  const key = `${norad}|${observer.lat}|${observer.lon}|${observer.alt_m ?? ""}`;
  const [store, setStore] = useState<{ key: string; state: PassState }>({ key, state: { s: "idle" } });
  const state: PassState = store.key === key ? store.state : { s: "idle" };

  const load = async () => {
    setStore({ key, state: { s: "loading" } });
    try {
      const data = await fetchPasses(norad, observer.lat, observer.lon, observer.alt_m);
      setStore({ key, state: { s: "ok", data } });
    } catch (e) {
      setStore({ key, state: { s: "error", msg: e instanceof ApiError ? e.message : "Could not load passes." } });
    }
  };

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h4 className="font-serif text-[18px] font-semibold">Visible passes</h4>
        <span className="truncate text-[14px] text-muted">from {observer.label}</span>
      </div>
      {state.s === "idle" && (
        <button type="button" onClick={() => void load()} className="quiet-btn">
          Show next 10 days
        </button>
      )}
      {state.s === "loading" && (
        <p className="flex items-center gap-2 text-[14px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Computing passes…
        </p>
      )}
      {state.s === "error" && (
        <div>
          <p className="text-[14px] text-rose">{state.msg}</p>
          <button type="button" onClick={() => void load()} className="quiet-btn mt-1.5">
            Try again
          </button>
        </div>
      )}
      {state.s === "ok" && (
        <div>
          {state.data.passes.length === 0 ? (
            <p className="text-[15px]">
              {state.data.always_above_horizon
                ? "Never sets from here (e.g. geostationary), so there are no passes."
                : state.data.horizon_passes
                  ? `${state.data.horizon_passes} passes above the horizon in the next 10 days, none visible (daylight, Earth's shadow or too low).`
                  : "No passes above the horizon in the next 10 days."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {state.data.passes.slice(0, 5).map((p) => (
                <li key={p.start_utc} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5">
                  <div className="flex items-baseline justify-between gap-2 font-mono text-[14px]">
                    <span>{fmtUtc(p.max_utc)} UTC</span>
                    <span className="text-gold">{Math.round(p.max_el)}° max</span>
                  </div>
                  <div className="font-mono text-[14px] text-muted">
                    rise {fmtHm(p.start_utc)} {p.start_az_compass} · peak {fmtHm(p.max_utc)} {p.max_az_compass} · set {fmtHm(p.end_utc)}{" "}
                    {p.end_az_compass}
                  </div>
                  {p.visible_start_utc && p.visible_end_utc && (
                    <div className="text-[14px] text-muted">
                      Visible <span className="font-mono text-ivory">{fmtHm(p.visible_start_utc)}–{fmtHm(p.visible_end_utc)}</span>
                      {p.visible_s !== undefined && ` · ${Math.max(1, Math.round(p.visible_s / 60))} min`}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-[14px] leading-snug text-muted">
            Computed with SGP4 from our catalog (est.). Visible = sunlit and at least 10° up while the sun is 6° or more below your
            horizon (assumed rule). Times in UTC.
            {state.data.cross_check &&
              ` N2YO cross-check: ${state.data.cross_check.matched} of its ${state.data.cross_check.n2yo_count} passes match within 5 min.`}
          </p>
        </div>
      )}
    </div>
  );
}

function Selected({
  entry,
  now,
  observer,
  onClear,
  onAddToSentinel,
}: {
  entry: CatalogEntry;
  now: Date | null;
  observer: Observer;
  onClear: () => void;
  onAddToSentinel?: (norad: number) => void;
}) {
  const satrec = useMemo(() => toSatrec(entry), [entry]);
  const altKm = useMemo(() => {
    if (!satrec || !now) return null;
    const p = positionAt(satrec, now);
    return p ? Math.hypot(...p) * R_EARTH_KM - R_EARTH_KM : null;
  }, [satrec, now]);
  const ageDays = now ? (now.getTime() - Date.parse(entry.epoch)) / 86_400_000 : null;

  return (
    <div>
      <div className="mb-1 flex items-start justify-between gap-3">
        <h3 className="font-serif text-[22px] font-semibold leading-tight text-gold">{entry.name}</h3>
        <button type="button" onClick={onClear} aria-label="Clear selection and return to Earth view" className="icon-btn -mr-2 h-8 w-8 shrink-0">
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>
      <div className="mb-1.5">
        <TypeBadge type={objectType(entry)} source={entry.type_source} />
      </div>
      <Row label="NORAD ID" value={entry.norad} />
      <Row label="Source" value={<span className="font-sans">{GROUP_LABELS[entry.group] ?? entry.group}</span>} />
      <Row label="Altitude now" value={altKm !== null ? altKm.toFixed(0) : DASH} unit="km" />
      <Row label="Perigee / apogee" value={`${entry.perigee_km.toFixed(0)} / ${entry.apogee_km.toFixed(0)}`} unit="km" />
      {satrec && <Row label="Inclination" value={inclinationDeg(satrec).toFixed(2)} unit="°" />}
      {satrec && <Row label="Period" value={periodMinutes(satrec).toFixed(1)} unit="min" />}
      <Row
        label="Element set age"
        value={ageDays === null ? DASH : Math.abs(ageDays) < 1 ? (ageDays * 24).toFixed(1) : ageDays.toFixed(1)}
        unit={ageDays !== null && Math.abs(ageDays) < 1 ? "h" : "d"}
      />
      <Row label="Position σ (assumed)" value={ageDays === null ? DASH : assumedSigmaKm(ageDays).toFixed(2)} unit="km" />
      {ageDays !== null && ageDays > STALE_TLE_DAYS && (
        <p className="mt-1.5 text-[14px] text-amber">Element set is over {STALE_TLE_DAYS} days old; position is unreliable.</p>
      )}
      <p className="mt-1.5 text-[14px] leading-snug text-muted">
        Assumed σ: 0.5 km + 1 km per day of element age (TLEs carry no covariance).
      </p>
      {onAddToSentinel && (
        <button type="button" className="quiet-btn mt-2.5" onClick={() => onAddToSentinel(entry.norad)}>
          Add to Sentinel
        </button>
      )}
      <VisiblePasses norad={entry.norad} observer={observer} />
    </div>
  );
}

/** Left edge panel: stats, search / lookup, type legend, paste-TLE and the selected object. */
export function LeftPanel({
  catalog,
  counts,
  medianAge,
  source,
  typesInferred,
  fps,
  layers,
  onToggleLayer,
  selected,
  now,
  observer,
  onSelect,
  onLookup,
  onAddPasted,
  onClear,
  onAddToSentinel,
  open,
  onToggle,
  top,
}: {
  catalog: CatalogEntry[];
  counts: Record<ObjectType, number>;
  medianAge: string | null;
  source: string | null;
  typesInferred: boolean;
  fps: number | null;
  layers: LayerVisibility;
  onToggleLayer: (t: ObjectType) => void;
  selected: CatalogEntry | null;
  now: Date | null;
  observer: Observer;
  onSelect: (norad: number) => void;
  onLookup: (norad: number) => Promise<void>;
  onAddPasted: (entry: CatalogEntry) => void;
  onClear: () => void;
  onAddToSentinel?: (norad: number) => void;
  open: boolean;
  onToggle: () => void;
  top: number;
}) {
  return (
    <EdgePanel side="left" label="Catalog" icon={Gauge} open={open} onToggle={onToggle} top={top}>
      <Stats now={now} total={catalog.length} medianAge={medianAge} source={source ? (SOURCE_LABELS[source] ?? source) : null} fps={fps} />
      <div className="divider my-4" />
      <SectionTitle>Objects</SectionTitle>
      <Search catalog={catalog} onSelect={onSelect} onLookup={onLookup} />
      <Legend counts={counts} layers={layers} onToggle={onToggleLayer} inferred={typesInferred} />
      <div className="divider my-4" />
      <PasteTle onAdd={onAddPasted} />
      <div className="divider my-4" />
      {selected ? (
        <Selected entry={selected} now={now} observer={observer} onClear={onClear} onAddToSentinel={onAddToSentinel} />
      ) : (
        <p className="text-[17px] text-ivory">Click any point on the globe, or search, to inspect it.</p>
      )}
    </EdgePanel>
  );
}
