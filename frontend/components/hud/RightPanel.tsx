"use client";

import { Crosshair, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchReentry,
  fetchSpaceWeather,
  objectType,
  rcsLabel,
  type AvoidResponse,
  type CatalogEntry,
  type Conjunction,
  type Decision,
  type Explanation,
  type OfficialType,
  type ReentryItem,
  type ScreenStats,
  type SpaceWeather,
} from "@/lib/api";
import { AvoidancePanel } from "./AvoidancePanel";
import { DecisionBadge, DecisionCard, DecisionRulesSection, EarlyFlagTag } from "./DecisionCard";
import { EdgePanel } from "./EdgePanel";
import { DASH, fmtTcaPlace, Row, SectionTitle, TypeBadge } from "./Glass";

export interface ScreenParams {
  horizon_h: number;
  screen_km: number;
  hbr_m: number;
}

export type ScreenState =
  | { s: "idle" }
  | { s: "running"; norad: number }
  | { s: "error"; msg: string }
  | { s: "done"; results: Conjunction[]; stats: ScreenStats | null };

const SHOWN = 20;
const ISS_NORAD = 25544;

const typeOf = (t: OfficialType) => objectType({ object_type: t } as CatalogEntry);

export function fmtPc(pc: number): string {
  return pc < 1e-12 ? "< 1e-12" : pc.toExponential(1).replace("e-", "e−");
}

function fmtCountdown(tcaIso: string, now: Date | null): string {
  if (!now) return DASH;
  const ms = Date.parse(tcaIso) - now.getTime();
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3.6e6);
  const m = Math.floor((abs % 3.6e6) / 6e4);
  const s = Math.floor((abs % 6e4) / 1000);
  const body = h > 0 ? `${h} h ${String(m).padStart(2, "0")} m` : `${m} m ${String(s).padStart(2, "0")} s`;
  return ms >= 0 ? `in ${body}` : `${body} ago`;
}

/** AI risk as a percentage (probability that the final risk ends >= 1e-6). */
export function fmtAi(p: number): string {
  if (p < 0.001) return "< 0.1%";
  return `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
}

/** The live model's estimate for a conjunction, always labelled as a model estimate. */
export function AiRisk({ c, size = 28 }: { c: Conjunction; size?: number }) {
  if (c.ai_p_high === undefined) {
    return (
      <div>
        <div className="font-mono leading-none text-ivory/40" style={{ fontSize: size }}>
          {DASH}
        </div>
        <div className="mt-1 text-[14px] text-muted">AI risk unavailable</div>
      </div>
    );
  }
  return (
    <div title="Probability, learned from ESA conjunction data, that the final collision risk will be at least 1e-6. A model estimate, not a measurement.">
      <div className="font-mono leading-none text-ivory" style={{ fontSize: size }}>
        {fmtAi(c.ai_p_high)}
      </div>
      <div className="mt-1 text-[14px] text-muted">AI risk (model est.)</div>
    </div>
  );
}

const levelColor = (c: Conjunction) => (c.level === "alert" ? "text-rose" : c.level === "watch" ? "text-gold" : "text-ivory");

const conjKey = (c: Conjunction) => `${c.primary_norad}|${c.norad}|${c.tca_utc}`;

function AlertCard({
  c,
  decision,
  primary,
  active,
  now,
  onFocus,
}: {
  c: Conjunction;
  decision?: Decision;
  primary: CatalogEntry | null;
  active: boolean;
  now: Date | null;
  onFocus: () => void;
}) {
  const protecting = c.primary_name ?? primary?.name ?? null;
  const primaryRcs = c.primary_rcs_size !== undefined ? c.primary_rcs_size : primary?.rcs_size;
  return (
    <button
      type="button"
      onClick={onFocus}
      aria-pressed={active}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors duration-500 ${
        active ? "border-gold/50 bg-white/[0.06]" : "border-white/8 bg-white/[0.02] hover:border-white/20"
      }`}
    >
      {protecting && (
        <div className="mb-0.5 truncate text-[14px] text-muted">
          Protecting: <span className="text-ivory">{protecting}</span> · size {rcsLabel(primaryRcs)}
        </div>
      )}
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[15px] font-semibold">{c.name}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          {decision?.early_flag && <EarlyFlagTag />}
          {decision && <DecisionBadge d={decision} />}
          <span className="font-mono text-[14px] text-muted">{c.norad}</span>
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-3">
        <div>
          <div className={`font-mono text-[28px] leading-none ${levelColor(c)}`}>{fmtPc(c.pc)}</div>
          <div className="mt-1 text-[14px] text-muted">Physics Pc</div>
        </div>
        <AiRisk c={c} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[14px] text-muted">
        <span className="text-ivory">{c.miss_km.toFixed(2)} km</span>
        <span>{fmtCountdown(c.tca_utc, now)}</span>
        <span>{c.vrel_kms.toFixed(2)} km/s</span>
        <span>σ {c.sigma_km.toFixed(2)} km (assumed)</span>
      </div>
      {c.radial_km !== undefined && (
        <div
          className="mt-0.5 font-mono text-[14px] text-muted"
          title="Separation at closest approach in the protected object's frame: radial, in-track, cross-track"
        >
          R {Math.abs(c.radial_km).toFixed(2)} · T {Math.abs(c.in_track_km ?? 0).toFixed(2)} · N {Math.abs(c.cross_track_km ?? 0).toFixed(2)} km
        </div>
      )}
      <div className="mt-1 text-[14px] leading-snug text-muted">
        <div title="Point midway between the two objects at closest approach (WGS-84)">
          TCA location <span className="whitespace-nowrap font-mono text-ivory">{fmtTcaPlace(c)}</span>
        </div>
        <div title="Space-Track radar cross-section class (RCS_SIZE)">
          Object size (RCS) <span className="text-ivory">{rcsLabel(c.secondary_rcs_size)}</span>
        </div>
      </div>
      {c.ai_in_domain === false && (
        <div className="mt-1 text-[14px] leading-snug text-muted">AI risk is outside its training range here (TCA under 2 days or over 7 days away).</div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {primary && <TypeBadge type={objectType(primary)} source={primary.type_source} />}
        <span className="text-[14px] text-muted">vs</span>
        <TypeBadge type={typeOf(c.object_type)} />
      </div>
    </button>
  );
}

function SpaceWeatherSection() {
  const [sw, setSw] = useState<SpaceWeather | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchSpaceWeather()
      .then(setSw)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Unavailable."));
  }, []);
  return (
    <section>
      <SectionTitle>Space weather</SectionTitle>
      {err && <p className="text-[14px] text-rose">{err}</p>}
      <Row label="Solar flux F10.7" value={sw ? sw.f107.toFixed(0) : DASH} unit="sfu" />
      <Row label="Kp index" value={sw ? sw.kp.toFixed(2) : DASH} />
      <Row label="Ap (24 h mean)" value={sw?.ap != null ? sw.ap.toFixed(1) : DASH} />
      <Row label="F10.7, last 27 days (mean)" value={sw?.f107_27d_mean != null ? sw.f107_27d_mean.toFixed(0) : DASH} unit="sfu" />
      <Row label="F10.7, next 27 days (forecast mean)" value={sw?.outlook?.f107_mean != null ? sw.outlook.f107_mean.toFixed(0) : DASH} unit="sfu" />
      {sw && (
        <p className="mt-1 text-[14px] text-muted">
          NOAA SWPC · Kp at {sw.kp_time_utc.slice(5, 16).replace("T", " ")} UTC{sw.stale ? " · cached (feed unavailable)" : ""}
          {sw.outlook?.issued ? ` · 27-day outlook issued ${sw.outlook.issued}` : ""}
        </p>
      )}
    </section>
  );
}

function ReentrySection({ onFocus, activeNorad }: { onFocus: (r: ReentryItem) => void; activeNorad: number | null }) {
  const [rows, setRows] = useState<ReentryItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchReentry(10)
      .then(setRows)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Unavailable."));
  }, []);
  return (
    <section>
      <SectionTitle>Re-entry watch</SectionTitle>
      {err && <p className="text-[14px] text-rose">{err}</p>}
      {!rows && !err && <p className="text-[14px] text-muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="text-[15px]">No objects below 400 km with a measurable decay rate.</p>}
      <ul className="space-y-0.5">
        {rows?.map((r) => (
          <li key={r.norad}>
            <button
              type="button"
              onClick={() => onFocus(r)}
              aria-pressed={activeNorad === r.norad}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[15px] transition-colors duration-500 hover:bg-white/[0.05] hover:text-gold ${
                activeNorad === r.norad ? "bg-white/[0.06] text-amber" : ""
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="font-mono text-[14px] text-muted">{Math.round(r.perigee_km)} km</span>
              <span
                title={
                  r.sw_factor != null
                    ? `Decay-rate heuristic ${r.est_days_raw} d × space-weather factor ${r.sw_factor} (F10.7 ${r.f107_recent} recent vs ${r.f107_forecast_mean} forecast) (est.)`
                    : undefined
                }
                className={`w-[92px] text-right font-mono text-[14px] ${r.risk === "high" ? "text-rose" : r.risk === "medium" ? "text-gold" : ""}`}
              >
                {r.overdue ? "imminent (est.)" : `est. ${r.est_days < 1 ? "< 1" : r.est_days.toFixed(0)} d`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[14px] leading-snug text-muted">
        Heuristic from the TLE mean-motion derivative, scaled by NOAA&apos;s 27-day F10.7 outlook: time × (recent F10.7 ÷ forecast
        F10.7)^1.5, an assumed density sensitivity (est.). Usually an overestimate. &ldquo;Imminent (est.)&rdquo;: the
        estimated date has already passed since the element set was issued, so re-entry is expected within hours to days
        (or has happened). Click one to focus it.
      </p>
    </section>
  );
}

/** Count on the Screening pill: rose = approaches above Pc 1e-4, neutral = approaches found. */
function ScreenBadge({ alerts, total }: { alerts: number; total: number }) {
  if (alerts > 0)
    return (
      <span
        aria-label={`${alerts} high-risk alerts`}
        className="ml-0.5 rounded-full bg-rose px-1.5 font-mono text-[14px] leading-[20px] text-space"
      >
        {alerts}
      </span>
    );
  return (
    <span aria-label={`${total} approaches, none high-risk`} className="ml-0.5 rounded-full border border-white/20 px-1.5 font-mono text-[14px] leading-[18px] text-ivory">
      {total}
    </span>
  );
}

/** Right edge panel "Screening": run /screen, browse alerts, size maneuvers, space weather, re-entry. */
export function RightPanel({
  asset,
  byNorad,
  screenState,
  onScreen,
  active,
  onFocus,
  onPick,
  activeReentry,
  onFocusReentry,
  showAvoidPath,
  onShowAvoidPath,
  onAvoidPlan,
  now,
  open,
  onToggle,
  top,
  panelTop,
}: {
  asset: CatalogEntry | null;
  byNorad: Map<number, CatalogEntry>;
  screenState: ScreenState;
  onScreen: (norad: number, p: ScreenParams) => void;
  active: Conjunction | null;
  onFocus: (c: Conjunction) => void;
  onPick: (norad: number) => Promise<void>;
  activeReentry: number | null;
  onFocusReentry: (r: ReentryItem) => void;
  showAvoidPath: boolean;
  onShowAvoidPath: (v: boolean) => void;
  onAvoidPlan: (plan: AvoidResponse | null) => void;
  now: Date | null;
  open: boolean;
  onToggle: () => void;
  top: number;
  panelTop: number;
}) {
  const [params, setParams] = useState<ScreenParams>({ horizon_h: 24, screen_km: 10, hbr_m: 20 });
  const running = screenState.s === "running";
  const done = screenState.s === "done" ? screenState : null;
  const primary = done?.stats ? (byNorad.get(done.stats.primary_norad) ?? null) : asset;

  // Final decisions from /avoid (which knows whether a valid option exists) replace the provisional ones from /screen.
  const [finals, setFinals] = useState<Record<string, { decision: Decision; explanation?: Explanation }>>({});
  const activeRef = useRef<Conjunction | null>(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const handlePlan = useCallback(
    (plan: AvoidResponse | null) => {
      onAvoidPlan(plan);
      const a = activeRef.current;
      if (plan?.decision && a && plan.secondary.norad === a.norad) {
        const d = plan.decision;
        setFinals((f) => ({ ...f, [conjKey(a)]: { decision: d, explanation: plan.explanation } }));
      }
    },
    [onAvoidPlan],
  );
  const decisionOf = (c: Conjunction) => finals[conjKey(c)]?.decision ?? c.decision;
  const counts = done
    ? (["GO", "MONITOR", "WATCH", "NO-GO"] as const).map((k) => [k, done.results.filter((c) => decisionOf(c)?.decision === k).length] as const)
    : [];

  return (
    <EdgePanel
      side="right"
      label="Screening"
      icon={Crosshair}
      open={open}
      onToggle={onToggle}
      top={top}
      panelTop={panelTop}
      badge={done && <ScreenBadge alerts={done.stats?.alerts ?? done.results.filter((c) => c.alert).length} total={done.results.length} />}
    >
      <div className="mb-3 rounded-xl bg-white/[0.04] px-3 py-2.5">
        <div className="text-[14px] text-muted">Protecting</div>
        {asset ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-serif text-[20px] font-semibold leading-tight">{asset.name}</span>
            <TypeBadge type={objectType(asset)} />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[15px]">No object selected</span>
            <button type="button" onClick={() => void onPick(ISS_NORAD)} className="quiet-btn">
              Use the ISS
            </button>
          </div>
        )}
      </div>
      <SectionTitle>Screening</SectionTitle>
      {!asset && <p className="mt-1 text-[14px] text-muted">Or select any object on the globe or in Catalog.</p>}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="text-[14px] text-muted">
          Window
          <select
            value={params.horizon_h}
            onChange={(e) => setParams({ ...params, horizon_h: Number(e.target.value) })}
            className="field mt-1 px-2"
          >
            <option value={6}>6 h</option>
            <option value={24}>24 h</option>
            <option value={72}>72 h</option>
          </select>
        </label>
        <label className="text-[14px] text-muted">
          Distance km
          <input
            type="number"
            min={1}
            max={50}
            value={params.screen_km}
            onChange={(e) => setParams({ ...params, screen_km: Math.max(1, Math.min(50, Number(e.target.value) || 10)) })}
            className="field mt-1 px-2"
          />
        </label>
        <label className="text-[14px] text-muted">
          HBR m
          <input
            type="number"
            min={1}
            max={500}
            value={params.hbr_m}
            onChange={(e) => setParams({ ...params, hbr_m: Math.max(1, Math.min(500, Number(e.target.value) || 20)) })}
            className="field mt-1 px-2"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={!asset || running}
        onClick={() => asset && onScreen(asset.norad, params)}
        className="quiet-btn primary mt-3 inline-flex items-center justify-center gap-2"
      >
        {running && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
        {running ? "Screening the full catalog…" : "Screen for conjunctions"}
      </button>
      {running && <p className="mt-1.5 text-[14px] text-muted">SGP4 over every object for the whole window; takes 10–20 s.</p>}
      {screenState.s === "error" && <p className="mt-1.5 text-[14px] text-rose">{screenState.msg}</p>}

      {done && (
        <div className="mt-4">
          {done.stats && (
            <p className="text-[14px] leading-snug text-muted">
              {done.stats.objects_in_catalog.toLocaleString()} objects screened against {done.stats.primary_name} over{" "}
              {done.stats.horizon_h} h in {done.stats.seconds.toFixed(1)} s ({done.stats.pairs_per_sec?.toLocaleString()} pairs/s).
              The perigee/apogee filter kept {done.stats.pairs_after_altitude_filter.toLocaleString()}
              {done.stats.co_located_excluded > 0 && `; ${done.stats.co_located_excluded} docked or co-located objects excluded`}.
            </p>
          )}
          <div className="divider my-3" />
          <SectionTitle>Alerts</SectionTitle>
          {done.results.length === 0 ? (
            <p className="text-[15px]">
              No approaches within {done.stats?.screen_km ?? params.screen_km} km in this window. Widen the distance or the
              window to see the nearest passes.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[15px]">
                <span className="font-mono">{done.results.length}</span> approaches within {done.stats?.screen_km} km
                {" · "}
                <span className={done.stats?.alerts ? "text-rose" : ""}>
                  <span className="font-mono">{done.stats?.alerts ?? 0}</span> above Pc 1e−4
                </span>
              </p>
              <p className="mb-2 text-[14px] text-muted">
                {counts
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${n} ${k === "NO-GO" ? "no-go" : k === "MONITOR" ? "monitor" : k.toLowerCase()}`)
                  .join(" · ")}
                {" · sorted by recommendation, then Pc"}
              </p>
              <ul className="space-y-2">
                {done.results.slice(0, SHOWN).map((c) => {
                  const isActive = active?.norad === c.norad && active.tca_utc === c.tca_utc;
                  const fin = finals[conjKey(c)];
                  const d = fin?.decision ?? c.decision;
                  return (
                    <li key={`${c.norad}-${c.tca_utc}`}>
                      <AlertCard c={c} decision={d} primary={primary} active={isActive} now={now} onFocus={() => onFocus(c)} />
                      {isActive && d && <DecisionCard d={d} ex={fin?.explanation ?? c.explanation} />}
                      {isActive && (
                        <AvoidancePanel
                          c={c}
                          primary={primary}
                          secondaryType={c.object_type}
                          showPath={showAvoidPath}
                          onShowPath={onShowAvoidPath}
                          onPlan={handlePlan}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
              {done.results.length > SHOWN && <p className="mt-1.5 text-[14px] text-muted">Showing the first {SHOWN} approaches.</p>}
              <DecisionRulesSection />
              <p className="mt-2 text-[14px] leading-snug text-muted">
                σ is assumed (0.5 km + 1 km per day of TLE age, per object). AI risk is the live model&apos;s estimate,
                learned from ESA conjunction data, that the final risk ends at or above 1e−6; see the Model tab. Click an
                approach to jump to its closest approach and draw the line between both objects.
              </p>
            </>
          )}
        </div>
      )}

      <div className="divider my-4" />
      <SpaceWeatherSection />
      <div className="divider my-4" />
      <ReentrySection onFocus={onFocusReentry} activeNorad={activeReentry} />
    </EdgePanel>
  );
}
