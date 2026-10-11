"use client";

import { ChevronDown, Loader2, LocateFixed, MapPin, Search } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, fetchAbove, objectType, type AboveResponse, type CatalogEntry } from "@/lib/api";
import { GEOCODE_ATTRIBUTION, GeocodeError, searchPlaces, type Place } from "@/lib/geocode";
import type { Observer } from "@/lib/observer";
import { EdgePanel } from "./EdgePanel";
import { SectionTitle, TypeBadge } from "./Glass";

const MAX_LISTED = 40;
const GEO_TIMEOUT_MS = 10_000;

type AboveState = { s: "idle" } | { s: "loading" } | { s: "error"; msg: string } | { s: "ok"; data: AboveResponse };
type SearchState =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "error"; msg: string }
  | { s: "results"; query: string; places: Place[] };

const fmtCoord = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;

function geoErrorMessage(e: GeolocationPositionError): string {
  if (e.code === e.PERMISSION_DENIED) return "Location permission was denied. Allow it in your browser, or search for a city instead.";
  if (e.code === e.TIMEOUT) return "Finding your location timed out. Try again, or search for a city.";
  return "Your location is unavailable right now. Search for a city instead.";
}

/** Where the satellites are computed for: shows the place, lets the user search a city or use the browser location. */
function LocationPicker({ observer, onObserver }: { observer: Observer; onObserver: (o: Observer) => void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ s: "idle" });
  const [locating, setLocating] = useState(false);
  const [geoNote, setGeoNote] = useState<string | null>(null);
  const [coordsOpen, setCoordsOpen] = useState(false);
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [coordsMsg, setCoordsMsg] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const runSearch = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSearch({ s: "loading" });
    setGeoNote(null);
    try {
      const places = await searchPlaces(q, ctrl.signal);
      setSearch({ s: "results", query: q, places });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setSearch({ s: "error", msg: e instanceof GeocodeError ? e.message : "Location search failed." });
    }
  };

  const choose = (p: Place) => {
    onObserver({
      lat: p.lat,
      lon: p.lon,
      label: p.name,
      detail: p.region || undefined,
      ...(p.elevation !== null ? { alt_m: p.elevation } : {}),
    });
    setSearch({ s: "idle" });
    setQuery("");
    setGeoNote(null);
  };

  const useMyLocation = () => {
    if (!("geolocation" in navigator)) {
      setGeoNote("This browser does not support geolocation. Search for a city instead.");
      return;
    }
    setLocating(true);
    setGeoNote(null);
    setSearch({ s: "idle" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const lat = +pos.coords.latitude.toFixed(4);
        const lon = +pos.coords.longitude.toFixed(4);
        onObserver({
          lat,
          lon,
          label: "My location",
          detail: fmtCoord(lat, lon),
          ...(typeof pos.coords.altitude === "number" ? { alt_m: pos.coords.altitude } : {}),
        });
      },
      (err) => {
        setLocating(false);
        setGeoNote(geoErrorMessage(err));
      },
      { timeout: GEO_TIMEOUT_MS, maximumAge: 5 * 60_000 },
    );
  };

  const applyCoords = () => {
    const la = Number(lat);
    const lo = Number(lon);
    if (lat.trim() === "" || lon.trim() === "" || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
      setCoordsMsg("Latitude must be −90…90 and longitude −180…180.");
      return;
    }
    setCoordsMsg(null);
    onObserver({ lat: la, lon: lo, label: "Custom location", detail: fmtCoord(la, lo) });
  };

  return (
    <div>
      <div className="flex items-start gap-2.5">
        <MapPin className="mt-1 h-4 w-4 shrink-0 text-gold" strokeWidth={1.75} />
        <div className="min-w-0">
          <div className="truncate font-serif text-[20px] font-semibold leading-tight">{observer.label}</div>
          <div className="truncate text-[14px] text-muted">{observer.detail ?? fmtCoord(observer.lat, observer.lon)}</div>
          <div className="font-mono text-[14px] text-muted">
            {observer.lat.toFixed(4)}, {observer.lon.toFixed(4)}
            {observer.alt_m !== undefined && ` · ${Math.round(observer.alt_m)} m`}
          </div>
        </div>
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch();
        }}
      >
        <label htmlFor="city-search" className="sr-only">
          Search for a city
        </label>
        <input
          id="city-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a city, e.g. Pune"
          autoComplete="off"
          className="field min-w-0"
        />
        <button
          type="submit"
          disabled={query.trim().length < 2 || search.s === "loading"}
          aria-label="Search"
          className="quiet-btn inline-flex shrink-0 items-center"
        >
          {search.s === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Search className="h-4 w-4" strokeWidth={1.75} />
          )}
        </button>
      </form>

      {search.s === "error" && <p className="mt-1.5 text-[14px] text-rose">{search.msg}</p>}
      {search.s === "results" &&
        (search.places.length === 0 ? (
          <p className="mt-1.5 text-[14px] text-muted">No place found for &ldquo;{search.query}&rdquo;. Try a different spelling or add the state or country.</p>
        ) : (
          <ul className="mt-1.5 space-y-0.5">
            {search.places.map((p) => (
              <li key={`${p.lat},${p.lon}`}>
                <button
                  type="button"
                  onClick={() => choose(p)}
                  className="w-full rounded-lg px-2 py-1 text-left transition-colors duration-500 hover:bg-white/[0.05] hover:text-gold"
                >
                  <div className="text-[15px]">{p.name}</div>
                  <div className="text-[14px] text-muted">{p.region || "Unknown region"}</div>
                </button>
              </li>
            ))}
          </ul>
        ))}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={useMyLocation} disabled={locating} className="quiet-btn inline-flex items-center gap-1.5">
          {locating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <LocateFixed className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
          {locating ? "Waiting for permission…" : "Use my location"}
        </button>
      </div>
      {geoNote && <p className="mt-1.5 text-[14px] text-rose">{geoNote}</p>}

      <button
        type="button"
        onClick={() => setCoordsOpen((o) => !o)}
        aria-expanded={coordsOpen}
        className="mt-2 flex items-center gap-1 text-[14px] text-muted transition-colors duration-500 hover:text-gold"
      >
        Enter coordinates
        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-500 motion-reduce:transition-none ${coordsOpen ? "rotate-180" : ""}`} />
      </button>
      {coordsOpen && (
        <div className="mt-1.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[14px] text-muted">
              Latitude
              <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" placeholder="15.3647" className="field mt-1 px-2" />
            </label>
            <label className="text-[14px] text-muted">
              Longitude
              <input value={lon} onChange={(e) => setLon(e.target.value)} inputMode="decimal" placeholder="75.1240" className="field mt-1 px-2" />
            </label>
          </div>
          <button type="button" onClick={applyCoords} className="quiet-btn mt-2">
            Use these coordinates
          </button>
          {coordsMsg && <p className="mt-1.5 text-[14px] text-rose">{coordsMsg}</p>}
        </div>
      )}
      <p className="mt-2 text-[14px] leading-snug text-muted">{GEOCODE_ATTRIBUTION}. Your choice is remembered for this session.</p>
    </div>
  );
}

/** "Above me": catalog objects currently over the observer, computed by the backend with SGP4 (N2YO only cross-checks). */
export function AbovePanel({
  observer,
  onObserver,
  byNorad,
  onPick,
  open,
  onToggle,
  top,
  panelTop,
}: {
  observer: Observer;
  onObserver: (o: Observer) => void;
  byNorad: Map<number, CatalogEntry>;
  onPick: (norad: number) => Promise<void>;
  open: boolean;
  onToggle: () => void;
  top: number;
  panelTop: number;
}) {
  const [radius, setRadius] = useState(70);
  const [state, setState] = useState<AboveState>({ s: "idle" });
  const [note, setNote] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);

  const load = async (o: Observer = observer, r: number = radius) => {
    setState({ s: "loading" });
    try {
      setState({ s: "ok", data: await fetchAbove(o.lat, o.lon, r, o.alt_m) });
    } catch (e) {
      setState({ s: "error", msg: e instanceof ApiError ? e.message : "Request failed." });
    }
  };

  const changeObserver = (o: Observer) => {
    onObserver(o);
    void load(o);
  };

  const pick = async (norad: number) => {
    setPicking(norad);
    try {
      await onPick(norad);
      setNote(null);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "Could not load that object.");
    } finally {
      setPicking(null);
    }
  };

  return (
    <EdgePanel
      side="right"
      label="Above me"
      icon={MapPin}
      open={open}
      onToggle={() => {
        if (!open && state.s === "idle") void load();
        onToggle();
      }}
      top={top}
      panelTop={panelTop}
    >
      <SectionTitle>Location</SectionTitle>
      <LocationPicker observer={observer} onObserver={changeObserver} />

      <div className="divider my-4" />
      <SectionTitle>Above {observer.label}</SectionTitle>
      <div className="flex items-end gap-2">
        <label className="w-24 text-[14px] text-muted">
          Radius °
          <input
            type="number"
            min={0}
            max={90}
            value={radius}
            onChange={(e) => setRadius(Math.max(0, Math.min(90, Number(e.target.value) || 0)))}
            className="field mt-1 px-2"
          />
        </label>
        <button type="button" onClick={() => void load()} disabled={state.s === "loading"} className="quiet-btn">
          Refresh
        </button>
      </div>
      {note && <p className="mt-1.5 text-[14px] text-muted">{note}</p>}

      <div className="mt-3">
        {state.s === "loading" && (
          <p className="flex items-center gap-2 text-[15px]">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Computing positions…
          </p>
        )}
        {state.s === "error" && (
          <div>
            <p className="text-[15px] text-rose">{state.msg}</p>
            <button type="button" onClick={() => void load()} className="quiet-btn mt-2">
              Try again
            </button>
          </div>
        )}
        {state.s === "ok" && (
          <div>
            <p className="mb-2 text-[15px]">
              <span className="font-mono">{state.data.count}</span> objects within {state.data.radius_deg}° of the zenith
              {state.data.cached ? " (cached)" : ""}.
            </p>
            <ul className="space-y-0.5">
              {state.data.satellites.slice(0, MAX_LISTED).map((s) => {
                const known = byNorad.get(s.norad);
                return (
                  <li key={s.norad}>
                    <button
                      type="button"
                      onClick={() => void pick(s.norad)}
                      disabled={picking !== null}
                      className="w-full rounded-lg px-2 py-1 text-left text-[15px] transition-colors duration-500 hover:bg-white/[0.05] hover:text-gold"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {s.el_deg !== undefined && (
                          <span className="font-mono text-[14px] text-ivory" title="Elevation above your horizon">
                            {Math.round(s.el_deg)}° {s.az_compass}
                          </span>
                        )}
                        {picking === s.norad && <Loader2 className="h-4 w-4 animate-spin self-center motion-reduce:animate-none" />}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        {known ? <TypeBadge type={objectType(known)} /> : <span className="text-[14px] text-muted">not loaded</span>}
                        <span className="font-mono text-[14px] text-muted">{Math.round(s.alt_km).toLocaleString()} km up</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {state.data.count > MAX_LISTED && (
              <p className="mt-1.5 text-[14px] text-muted">Showing the first {MAX_LISTED}. Narrow the radius to see fewer.</p>
            )}
            <p className="mt-2 text-[14px] leading-snug text-muted">
              Highest in your sky first. Computed with SGP4 from our catalog
              {state.data.computed_utc ? ` at ${state.data.computed_utc.slice(11, 16)} UTC` : ""}.
              {state.data.cross_check &&
                ` N2YO cross-check: ${state.data.cross_check.in_both} of its ${state.data.cross_check.n2yo_count} objects also listed here.`}{" "}
              Click one to fly to it.
            </p>
          </div>
        )}
      </div>
    </EdgePanel>
  );
}
