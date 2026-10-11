"use client";

import { Bell, BellRing, History, ListChecks, Loader2, Play, RotateCw, Search, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  rcsLabel,
  ApiError,
  addToWatchlist,
  fetchSentinelAlert,
  fetchSentinelAlerts,
  fetchWatchlist,
  removeFromWatchlist,
  runSentinel,
  setWatchTier,
  startReplay,
  stopReplay,
  type CatalogEntry,
  type CostOfActing,
  type HistoryPoint,
  type ReplayPoint,
  type ReplayState,
  type SentinelAlert,
  type SentinelAlertDetail,
  type SentinelStatus,
  type SentinelStatusCode,
  type Tier,
  type WatchItem,
  fmtSci,
} from "@/lib/api";
import { notificationsSupported } from "@/lib/sentinel";
import { PALETTE } from "@/lib/theme";
import { DecisionBadge, DecisionCard } from "../hud/DecisionCard";
import { EdgePanel, PILL_GAP, PILL_HEIGHT } from "../hud/EdgePanel";
import { FuelBreakdown, fmtDvUnit, fmtMass } from "../hud/FuelBreakdown";
import { DASH, fmtTcaPlace, Glass, Row, SectionTitle } from "../hud/Glass";

const STATUS_TONE: Record<SentinelStatusCode, string> = {
  "CONFIRMED GO": PALETTE.rose,
  WATCH: PALETTE.gold,
  NEW: PALETTE.ice,
  RESOLVED: PALETTE.muted,
};
const STATUS_LABEL: Record<SentinelStatusCode, string> = {
  "CONFIRMED GO": "Confirmed GO",
  WATCH: "Watch",
  NEW: "New",
  RESOLVED: "Resolved",
};
const LADDER: SentinelStatusCode[] = ["NEW", "WATCH", "CONFIRMED GO", "RESOLVED"];
const TIERS: Tier[] = ["Crewed", "Critical", "Standard"];
const BOARD_PAGE = 30;
/** Default board filter: CONFIRMED GO, and WATCH at or above this Pc. */
const PRIORITY_PC = 1e-5;

const isPriority = (a: SentinelAlert) => a.status === "CONFIRMED GO" || (a.status === "WATCH" && a.pc >= PRIORITY_PC);

/** Group by protected satellite, keeping the board order (status, then Pc): the most urgent satellite comes first. */
function groupByPrimary(alerts: SentinelAlert[]): [number, SentinelAlert[]][] {
  const m = new Map<number, SentinelAlert[]>();
  for (const a of alerts) {
    const g = m.get(a.primary_norad);
    if (g) g.push(a);
    else m.set(a.primary_norad, [a]);
  }
  return [...m.entries()];
}

const fmtPc = (pc: number | null | undefined) =>
  pc == null ? DASH : pc < 1e-12 ? "< 1e−12" : pc.toExponential(1).replace("e-", "e−");
const fmtAi = (p: number | null | undefined) => (p == null ? DASH : p < 0.001 ? "< 0.1%" : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);
const fmtUtc = (iso: string | null | undefined) => (iso ? `${iso.slice(5, 16).replace("T", " ")} UTC` : DASH);
const fmtTime = (iso: string | null | undefined) => (iso ? `${iso.slice(11, 16)} UTC` : DASH);
const fmtT = (h: number) => (h < 0 ? "passed" : h < 1 ? `T−${Math.round(h * 60)} min` : `T−${h.toFixed(h < 10 ? 1 : 0)} h`);

export function StatusBadge({ s }: { s: SentinelStatusCode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/12 px-2 py-px text-[14px] text-ivory">
      <span className="h-2 w-2 rounded-full" style={{ background: STATUS_TONE[s] }} />
      {STATUS_LABEL[s]}
    </span>
  );
}

function Tag({ children, tone = PALETTE.muted, title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <span title={title} className="whitespace-nowrap rounded-full border px-2 py-px text-[14px]" style={{ borderColor: `${tone}66`, color: tone }}>
      {children}
    </span>
  );
}

// --------------------------------------------------------------------------- header

function LiveDot({ busy, ok }: { busy: boolean; ok: boolean }) {
  const c = !ok ? PALETTE.muted : busy ? PALETTE.gold : PALETTE.ice;
  return (
    <span className="relative inline-flex h-2.5 w-2.5" aria-hidden>
      {ok && <span className="absolute inset-0 animate-ping rounded-full opacity-40 motion-reduce:animate-none" style={{ background: c }} />}
      <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: c }} />
    </span>
  );
}

function HeaderFig({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[17px] leading-tight text-ivory">{value}</div>
      <div className="text-[14px] leading-tight text-muted">{label}</div>
    </div>
  );
}

function SentinelHeader({
  status,
  replay,
  onRun,
  onReplay,
  onStopReplay,
  notifState,
  onEnableNotif,
  banner,
  top,
}: {
  banner: string | null;
  status: SentinelStatus | null;
  replay: ReplayState | null;
  onRun: () => void;
  onReplay: () => void;
  onStopReplay: () => void;
  notifState: NotificationPermission | "unsupported";
  onEnableNotif: () => void;
  top: number;
}) {
  const last = status?.last_run;
  const replaying = !!replay?.active;
  return (
    <div className="pointer-events-none fixed inset-x-0 z-20 flex justify-center px-4" style={{ top }}>
      <Glass className="pointer-events-auto flex max-w-[980px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        {banner && (
          <div role="status" className="w-full rounded-full border border-gold/60 px-4 py-1 text-center text-[15px] font-semibold text-gold">
            {banner}
          </div>
        )}
        <div className="flex items-center gap-2.5">
          <LiveDot busy={!!status?.busy} ok={!!status?.running} />
          <span className="font-serif text-[20px] font-semibold">Sentinel</span>
          <span className="text-[14px] text-muted">
            {!status ? "connecting…" : !status.running ? "stopped" : status.busy ? (status.phase ?? "running") : "live"}
          </span>
        </div>
        <HeaderFig label="Last refresh" value={fmtTime(last?.finished_utc)} />
        <HeaderFig label="Next refresh" value={fmtTime(status?.next_refresh_utc)} />
        <HeaderFig label="Objects watched" value={status?.objects_watched ?? DASH} />
        <HeaderFig label="Pairs checked" value={last?.pairs_checked != null ? last.pairs_checked.toLocaleString() : DASH} />
        <HeaderFig label="Screening (72 h)" value={last?.screen_seconds != null ? `${last.screen_seconds.toFixed(0)} s` : DASH} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="quiet-btn inline-flex items-center gap-1.5" onClick={onRun} disabled={!status?.running || status?.busy}>
            <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} /> Run now
          </button>
          {replaying ? (
            <button type="button" className="quiet-btn inline-flex items-center gap-1.5" onClick={onStopReplay}>
              <Square className="h-3.5 w-3.5" strokeWidth={1.75} /> Stop replay
            </button>
          ) : (
            <button type="button" className="quiet-btn inline-flex items-center gap-1.5" onClick={onReplay}>
              <History className="h-3.5 w-3.5" strokeWidth={1.75} /> Replay a real event
            </button>
          )}
          {notifState !== "unsupported" && (
            <button
              type="button"
              className="icon-btn h-9 w-9"
              onClick={onEnableNotif}
              disabled={notifState !== "default"}
              title={notifState === "granted" ? "Browser notifications on" : notifState === "denied" ? "Notifications blocked in browser settings" : "Enable browser notifications"}
              aria-label="Browser notifications"
            >
              {notifState === "granted" ? <BellRing className="h-4 w-4 text-gold" strokeWidth={1.75} /> : <Bell className="h-4 w-4" strokeWidth={1.75} />}
            </button>
          )}
        </div>
        {last?.error && <p className="w-full text-[14px] text-rose">Last cycle failed: {last.error}</p>}
      </Glass>
    </div>
  );
}

// --------------------------------------------------------------------------- board

function AlertRow({ a, active, onPick, inGroup = false }: { a: SentinelAlert; active: boolean; onPick: () => void; inGroup?: boolean }) {
  const cost = a.cost_of_acting;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors duration-500 ${
        active ? "border-gold/50 bg-white/[0.06]" : "border-white/8 bg-white/[0.02] hover:border-white/20"
      } ${a.status === "RESOLVED" ? "opacity-70" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[15px] font-semibold">{inGroup ? `vs ${a.secondary_name}` : a.primary_name}</span>
        <StatusBadge s={a.status} />
      </div>
      {!inGroup && (
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[14px] text-muted">vs {a.secondary_name}</span>
          <span className="shrink-0 text-[14px] text-muted">{a.tier}</span>
        </div>
      )}
      <div className="mt-1.5 grid grid-cols-3 gap-2">
        <div>
          <div className="font-mono text-[20px] leading-none" style={{ color: a.status === "CONFIRMED GO" ? PALETTE.rose : PALETTE.ivory }}>
            {fmtPc(a.pc)}
          </div>
          <div className="mt-1 text-[14px] text-muted">Pc</div>
        </div>
        <div>
          <div className="font-mono text-[20px] leading-none text-ivory">{fmtAi(a.ai_p_high)}</div>
          <div className="mt-1 text-[14px] text-muted">AI (est.)</div>
        </div>
        <div>
          <div className="font-mono text-[20px] leading-none text-ivory">{fmtT(a.hours_to_tca)}</div>
          <div className="mt-1 text-[14px] text-muted">to TCA</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[14px] text-muted">
        <span className="text-ivory">{a.miss_km.toFixed(2)} km</span>
        <span>{cost.available ? `Δv ${fmtDvUnit(cost.dv_ms)}` : "Δv n/a"}</span>
        {cost.available && (
          <span title={cost.total_kg != null ? "Avoid + return burn (est.)" : "Avoidance burn only"}>
            fuel {fmtMass(cost.total_kg ?? cost.propellant_kg)}
            {cost.total_kg != null ? " (incl. return, est.)" : ""}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {/* The decision only adds information when it differs from the status (e.g. GO awaiting confirmation). */}
        {!(a.status === "WATCH" && a.decision === "WATCH") && a.status !== "CONFIRMED GO" && (
          <span className="flex items-center gap-1 text-[14px] text-muted">
            Decision <DecisionBadge d={{ decision: a.decision, label: a.decision, provisional: false } as Parameters<typeof DecisionBadge>[0]["d"]} />
          </span>
        )}
        {a.early_flag && <Tag tone={PALETTE.ice} title="AI flag without physics confirmation">AI early flag</Tag>}
        {a.stale && <Tag tone={PALETTE.amber} title="A TLE is older than 3 days">stale data</Tag>}
        {a.lower_confidence && a.hours_to_tca > 0 && <Tag title="TCA more than 48 h away: TLE errors grow with time">lower confidence</Tag>}
      </div>
    </button>
  );
}

function ReplayCard({ replay, active, onPick }: { replay: ReplayState; active: boolean; onPick: () => void }) {
  const cur = replay.current;
  const g = cur?.guard.status;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={`w-full rounded-xl border border-dashed px-3 py-2.5 text-left transition-colors duration-500 ${active ? "border-gold/60 bg-white/[0.06]" : "border-white/20 hover:border-white/35"}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[15px] font-semibold text-gold">Replay · ESA event {replay.event_id}</span>
        {g && <StatusBadge s={g} />}
      </div>
      <div className="mt-0.5 text-[14px] text-muted">
        CDM {replay.step ?? 0} of {replay.total} · {replay.finished ? "finished" : replay.active ? "playing" : "stopped"}
      </div>
      {cur && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[14px] text-muted">
          <span className="text-ivory">Pc {fmtPc(cur.record.pc)}</span>
          <span>AI {fmtAi(cur.record.ai_p_high)}</span>
          <span>T−{(cur.record.time_to_tca_d * 24).toFixed(0)} h</span>
        </div>
      )}
    </button>
  );
}

function AlertBoard({
  alerts,
  err,
  activeId,
  onPick,
  replay,
  replayActive,
  onPickReplay,
  open,
  onToggle,
  top,
}: {
  alerts: SentinelAlert[] | null;
  err: string | null;
  activeId: string | null;
  onPick: (a: SentinelAlert) => void;
  replay: ReplayState | null;
  replayActive: boolean;
  onPickReplay: () => void;
  open: boolean;
  onToggle: () => void;
  top: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(BOARD_PAGE);
  const all = alerts ?? [];
  // Default view: what needs attention. Everything else (lower-Pc WATCH, NEW AI-only flags, RESOLVED) behind "Show all".
  const priority = all.filter(isPriority);
  const hidden = all.length - priority.length;
  const shown = (showAll ? all : priority).slice(0, limit);
  const groups = groupByPrimary(shown);
  const total = showAll ? all.length : priority.length;
  const counts = all.reduce<Record<string, number>>((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {});
  const badge = priority.length > 0 && (
    <span
      className={`ml-0.5 rounded-full px-1.5 font-mono text-[14px] leading-[20px] ${counts["CONFIRMED GO"] ? "bg-rose text-space" : "border border-gold/50 text-gold"}`}
    >
      {priority.length}
    </span>
  );
  return (
    <EdgePanel side="left" label="Alerts" icon={ListChecks} open={open} onToggle={onToggle} top={top} badge={badge}>
      <SectionTitle>Alert board</SectionTitle>
      <p className="-mt-1 mb-3 text-[14px] leading-snug text-muted">
        {showAll ? "All alerts" : `Confirmed GO, and Watch with Pc ≥ ${fmtSci(PRIORITY_PC)}`}, grouped by protected satellite. {counts["CONFIRMED GO"] ?? 0}{" "}
        confirmed GO · {counts.WATCH ?? 0} watch · {counts.NEW ?? 0} new (AI early flag) · {counts.RESOLVED ?? 0} resolved.
      </p>
      {replay && (replay.active || replay.finished) && (
        <div className="mb-2">
          <ReplayCard replay={replay} active={replayActive} onPick={onPickReplay} />
        </div>
      )}
      {err && <p className="text-[14px] text-rose">{err}</p>}
      {!alerts && !err && <p className="text-[14px] text-muted">Loading…</p>}
      {alerts && total === 0 && (
        <p className="text-[15px]">No confirmed GO or Watch alert with Pc ≥ {fmtSci(PRIORITY_PC)} for the watchlist in the next 72 h.</p>
      )}
      <div className="space-y-4">
        {groups.map(([norad, items]) => (
          <section key={norad} aria-label={`Alerts for ${items[0].primary_name}`}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <h3 className="min-w-0 truncate text-[15px] font-semibold text-gold">{items[0].primary_name}</h3>
              <span className="shrink-0 text-[14px] text-muted">
                {items[0].tier} · {items.length}
              </span>
            </div>
            <ul className="space-y-2">
              {items.map((a) => (
                <li key={a.id}>
                  <AlertRow a={a} active={a.id === activeId} onPick={() => onPick(a)} inGroup />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {total > limit && (
        <button type="button" className="quiet-btn mt-2" onClick={() => setLimit((l) => l + BOARD_PAGE)}>
          Show {Math.min(BOARD_PAGE, total - limit)} more of {total - limit}
        </button>
      )}
      {hidden > 0 && (
        <button type="button" className="mt-3 block text-[14px] text-muted hover:text-gold" onClick={() => setShowAll((v) => !v)} aria-pressed={showAll}>
          {showAll ? "Show priority only" : `Show all (${hidden} more)`}
        </button>
      )}
      <div className="divider my-4" />
      <GuardLegend />
    </EdgePanel>
  );
}

function GuardLegend() {
  return (
    <details>
      <summary className="cursor-pointer text-[14px] text-muted hover:text-gold">False-alert guard</summary>
      <ul className="mt-2 space-y-1.5 text-[14px] leading-snug">
        <li>
          <StatusBadge s="NEW" /> AI early flag only. Physics does not confirm it; tracked, never escalated on its own.
        </li>
        <li>
          <StatusBadge s="WATCH" /> Physics-confirmed WATCH, or GO still waiting for confirmation, or GO capped by stale data.
        </li>
        <li>
          <StatusBadge s="CONFIRMED GO" /> GO, and either above the GO threshold on 2 consecutive data updates, or Pc and AI final risk both at GO
          level. Never with a TLE older than 3 days.
        </li>
        <li>
          <StatusBadge s="RESOLVED" /> New data lowered the risk below every threshold, the pass left the 10 km screen, or TCA passed.
        </li>
      </ul>
      <p className="mt-2 text-[14px] leading-snug text-muted">
        A data update is a refresh in which either object&apos;s element set changed. Downgrades are automatic; the history is kept.
      </p>
    </details>
  );
}

// --------------------------------------------------------------------------- detail

/** Status ladder with the current step highlighted. */
function Ladder({ s }: { s: SentinelStatusCode }) {
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-1 text-[14px]" aria-label="Status ladder">
      {LADDER.map((x, i) => (
        <li key={x} className="flex items-center gap-1">
          <span
            className="rounded-full px-2 py-px"
            style={x === s ? { background: `${STATUS_TONE[x]}26`, color: STATUS_TONE[x], border: `1px solid ${STATUS_TONE[x]}80` } : { color: PALETTE.muted, border: "1px solid rgb(255 255 255 / 0.08)" }}
          >
            {STATUS_LABEL[x]}
          </span>
          {i < LADDER.length - 1 && <span className="text-muted">→</span>}
        </li>
      ))}
    </ol>
  );
}

type SparkPoint = { label: string; value: number | null; status?: SentinelStatusCode };

/** One-series sparkline (no second axis). log=true plots log10(value). Hover a point for its values. */
function Spark({ points, log, title, fmt, color }: { points: SparkPoint[]; log?: boolean; title: string; fmt: (v: number) => string; color: string }) {
  const W = 290;
  const H = 74;
  const L = 6;
  const R = 6;
  const T = 8;
  const B = 8;
  const vals = points.map((p) => (p.value == null ? null : log ? Math.log10(Math.max(p.value, 1e-30)) : p.value));
  const finite = vals.filter((v): v is number => v != null);
  if (finite.length === 0) return null;
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi - lo < (log ? 1 : 0.02)) {
    const mid = (hi + lo) / 2;
    lo = mid - (log ? 0.5 : 0.01);
    hi = mid + (log ? 0.5 : 0.01);
  }
  const sx = (i: number) => (points.length === 1 ? W / 2 : L + (i / (points.length - 1)) * (W - L - R));
  const sy = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const path = vals
    .map((v, i) => (v == null ? null : `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
  const last = points[points.length - 1];
  return (
    <figure className="mt-2">
      <figcaption className="flex items-baseline justify-between text-[14px] text-muted">
        <span>{title}</span>
        <span className="font-mono text-ivory">{last.value != null ? fmt(last.value) : DASH}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-auto w-full" role="img" aria-label={`${title} over ${points.length} updates`}>
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="rgb(255 255 255 / 0.08)" />
        {points.length > 1 && <polyline points={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />}
        {vals.map((v, i) =>
          v == null ? null : (
            <g key={i}>
              <circle cx={sx(i)} cy={sy(v)} r={9} fill="transparent">
                <title>{`${points[i].label}: ${fmt(points[i].value as number)}${points[i].status ? ` · ${STATUS_LABEL[points[i].status as SentinelStatusCode]}` : ""}`}</title>
              </circle>
              <circle
                cx={sx(i)}
                cy={sy(v)}
                r={4}
                fill={points[i].status ? STATUS_TONE[points[i].status as SentinelStatusCode] : color}
                stroke={PALETTE.space}
                strokeWidth={2}
                pointerEvents="none"
              />
            </g>
          ),
        )}
      </svg>
      <div className="flex justify-between font-mono text-[14px] text-muted">
        <span>{points[0].label}</span>
        {points.length > 1 && <span>{last.label}</span>}
      </div>
    </figure>
  );
}

function CostVsRisk({ cost, pc, aiRisk, aiP, replay }: { cost: CostOfActing | null; pc: number; aiRisk: number | null; aiP: number | null; replay?: boolean }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-3">
      <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
        <div className="text-[14px] text-muted">Cost of acting</div>
        {replay ? (
          <p className="mt-1 text-[15px]">n/a in replay</p>
        ) : cost?.available ? (
          <>
            <div className="mt-1 font-mono text-[28px] leading-none text-ivory">{fmtDvUnit(cost.dv_ms)}</div>
            <div className="mt-1 text-[14px] text-muted">{cost.direction_label ?? cost.direction} (est.)</div>
            <div className="mt-1.5 font-mono text-[15px] text-ivory">{fmtMass(cost.total_kg ?? cost.propellant_kg)}</div>
            <div className="text-[14px] text-muted">
              propellant{cost.total_kg != null ? ", avoid + return (est.)" : ", avoid burn"}
              {cost.mass_assumed ? " (500 kg, 220 s assumed)" : ""}
            </div>
            <div className="mt-1.5 font-mono text-[15px] text-ivory">{fmtUtc(cost.burn_utc)}</div>
            <div className="text-[14px] text-muted">burn time{cost.maneuvering ? ` · ${cost.maneuvering}` : ""}</div>
          </>
        ) : (
          <p className="mt-1 text-[14px] leading-snug">{cost?.reason ?? "n/a"}</p>
        )}
      </div>
      <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
        <div className="text-[14px] text-muted">Risk of not acting</div>
        <div className="mt-1 font-mono text-[28px] leading-none" style={{ color: pc >= 1e-4 ? PALETTE.rose : PALETTE.ivory }}>
          {fmtPc(pc)}
        </div>
        <div className="mt-1 text-[14px] text-muted">Pc now</div>
        <div className="mt-1.5 font-mono text-[15px] text-ivory">{fmtPc(aiRisk)}</div>
        <div className="text-[14px] text-muted">AI-predicted final risk (est.)</div>
        <div className="mt-1.5 font-mono text-[15px] text-ivory">{fmtAi(aiP)}</div>
        <div className="text-[14px] text-muted">AI P(final ≥ 1e−6) (est.)</div>
      </div>
    </div>
  );
}

function historyPoints(h: HistoryPoint[]): { pc: SparkPoint[]; ai: SparkPoint[] } {
  const label = (t: string) => t.slice(5, 16).replace("T", " ");
  return {
    pc: h.map((p) => ({ label: label(p.t_utc), value: p.pc, status: p.status })),
    ai: h.map((p) => ({ label: label(p.t_utc), value: p.ai_p_high })),
  };
}

function AlertDetail({ d }: { d: SentinelAlertDetail }) {
  const hp = historyPoints(d.history);
  const aiRisk = d.ai_log10_risk != null ? 10 ** d.ai_log10_risk : null;
  return (
    <div>
      <div className="text-[14px] text-muted">
        Protecting: <span className="text-ivory">{d.primary_name}</span> · {d.tier}
      </div>
      <h3 className="font-serif text-[22px] font-semibold leading-tight text-gold">vs {d.secondary_name}</h3>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <StatusBadge s={d.status} />
        {d.early_flag && <Tag tone={PALETTE.ice}>AI early flag</Tag>}
        {d.stale && <Tag tone={PALETTE.amber}>stale data</Tag>}
        {d.lower_confidence && d.hours_to_tca > 0 && <Tag>lower confidence (&gt; 48 h)</Tag>}
      </div>
      <Ladder s={d.status} />
      <p className="mt-1.5 text-[15px] leading-snug">{d.status_reason}</p>
      <div className="mt-2">
        <Row label="TCA" value={fmtUtc(d.tca_utc)} />
        <Row label="Time to TCA" value={fmtT(d.hours_to_tca)} />
        <Row label="Miss distance" value={d.miss_km.toFixed(3)} unit="km" />
        <Row label="TCA location" value={fmtTcaPlace(d.record ?? {})} />
        <Row label={`Size (RCS), ${d.primary_name}`} value={<span className="font-sans">{rcsLabel(d.record?.primary_rcs_size)}</span>} />
        <Row label={`Size (RCS), ${d.secondary_name}`} value={<span className="font-sans">{rcsLabel(d.record?.secondary_rcs_size)}</span>} />
        <Row label="Data updates seen" value={d.updates} />
        <Row label="First seen" value={fmtUtc(d.first_seen)} />
      </div>
      <CostVsRisk cost={d.cost_of_acting} pc={d.pc} aiRisk={aiRisk} aiP={d.ai_p_high} />
      {d.cost_of_acting.available && d.plan && (
        <>
          <h4 className="mt-3 font-serif text-[19px] font-semibold">Fuel cost (est.)</h4>
          <FuelBreakdown plan={d.plan} />
        </>
      )}
      <div className="divider my-3" />
      <div className="text-[14px] text-muted">History (one point per data update)</div>
      <Spark points={hp.pc} log title="Pc (log scale)" fmt={(v) => fmtPc(v)} color={PALETTE.ivory} />
      <Spark points={hp.ai} title="AI P(high-risk) (est.)" fmt={(v) => fmtAi(v)} color={PALETTE.gold} />
      {d.decision_detail && <DecisionCard d={d.decision_detail} ex={d.explanation ?? undefined} />}
      {d.plan?.assumptions && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[14px] text-muted hover:text-gold">Avoidance plan assumptions</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[14px] leading-snug text-muted">
            {d.plan.assumptions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReplayDetail({ r }: { r: ReplayState }) {
  const cur = r.current;
  const pts: ReplayPoint[] = r.cdms ?? [];
  const lab = (p: ReplayPoint) => `T−${(p.time_to_tca_d * 24).toFixed(0)} h`;
  const aiRisk = cur?.record.ai_log10_risk != null ? 10 ** cur.record.ai_log10_risk : null;
  return (
    <div>
      <div className="text-[14px] text-muted">{r.primary_name}</div>
      <h3 className="font-serif text-[22px] font-semibold leading-tight text-gold">ESA event {r.event_id}</h3>
      <p className="mt-1 text-[14px] leading-snug text-muted">
        CDM {r.step} of {r.total}, one every {r.step_s} s, through the same AI, decision and false-alert guard as live alerts. Each CDM counts as
        one data update.
      </p>
      {cur && (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge s={cur.guard.status} />
            {cur.decision.early_flag && <Tag tone={PALETTE.ice}>AI early flag</Tag>}
          </div>
          <Ladder s={cur.guard.status} />
          <p className="mt-1.5 text-[15px] leading-snug">{cur.guard.reason}</p>
          <div className="mt-2">
            <Row label="Time to TCA" value={`${(cur.record.time_to_tca_d * 24).toFixed(1)} h`} />
            <Row label="Miss distance" value={cur.record.miss_km.toFixed(3)} unit="km" />
            <Row label="Relative speed" value={cur.record.vrel_kms.toFixed(2)} unit="km/s" />
            <Row label="Chaser type" value={<span className="font-sans">{cur.record.object_type}</span>} />
          </div>
          <CostVsRisk cost={null} pc={cur.record.pc} aiRisk={aiRisk} aiP={cur.record.ai_p_high ?? null} replay />
        </>
      )}
      <div className="divider my-3" />
      <div className="text-[14px] text-muted">CDM sequence</div>
      {pts.length > 0 && (
        <>
          <Spark points={pts.map((p) => ({ label: lab(p), value: p.pc, status: p.status }))} log title="ESA Pc (log scale)" fmt={(v) => fmtPc(v)} color={PALETTE.ivory} />
          <Spark points={pts.map((p) => ({ label: lab(p), value: p.ai_p_high }))} title="AI P(high-risk) (est.)" fmt={(v) => fmtAi(v)} color={PALETTE.gold} />
        </>
      )}
      {r.final && (
        <div className="mt-3 rounded-xl bg-white/[0.03] px-3 py-2.5">
          <div className="text-[14px] text-muted">Outcome: ESA&apos;s final CDM</div>
          <div className="mt-1 font-mono text-[28px] leading-none" style={{ color: r.final.high_risk ? PALETTE.rose : PALETTE.ivory }}>
            {fmtPc(r.final.pc)}
          </div>
          <div className="mt-1 text-[14px] text-muted">
            {r.final.high_risk ? "High risk (≥ 1e−6)" : "Below 1e−6"} at T−{((r.final.time_to_tca_d ?? 0) * 24).toFixed(0)} h, miss{" "}
            {r.final.miss_km?.toFixed(3)} km. {r.final.note}
          </div>
        </div>
      )}
      {cur && <DecisionCard d={cur.decision} ex={cur.explanation} />}
      <p className="mt-2 text-[14px] leading-snug text-muted">{r.source}. Avoidance and fuel: {r.avoidance}.</p>
    </div>
  );
}

// --------------------------------------------------------------------------- watchlist editor

function WatchlistEditor({ catalog, onChanged }: { catalog: CatalogEntry[]; onChanged: () => void }) {
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<Tier>("Standard");
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetchWatchlist()
      .then((w) => setItems(w.items))
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Unavailable."));
  useEffect(() => {
    void load();
  }, []);

  const watched = useMemo(() => new Set((items ?? []).map((i) => i.norad)), [items]);
  const matches = useMemo(() => {
    const s = q.trim().toUpperCase();
    if (s.length < 2) return [];
    const n = /^\d+$/.test(s) ? Number(s) : null;
    return catalog.filter((c) => (n !== null ? c.norad === n : c.name.toUpperCase().includes(s)) && !watched.has(c.norad)).slice(0, 6);
  }, [q, catalog, watched]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  };

  const groups = TIERS.map((t) => [t, (items ?? []).filter((i) => i.tier === t)] as const);
  return (
    <div>
      <SectionTitle>Watchlist</SectionTitle>
      <p className="-mt-1 mb-3 text-[14px] leading-snug text-muted">
        Screened against the full catalog every hour for the next 72 h. Priority: Crewed &gt; Critical &gt; Standard.
      </p>
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" strokeWidth={1.75} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or NORAD ID" className="field pl-8" aria-label="Find an object to add" />
        </label>
        <select value={tier} onChange={(e) => setTier(e.target.value as Tier)} className="field w-[112px] px-2" aria-label="Tier for new object">
          {TIERS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      {matches.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {matches.map((m) => (
            <li key={m.norad} className="flex items-center gap-2 text-[15px]">
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="font-mono text-[14px] text-muted">{m.norad}</span>
              <button type="button" className="quiet-btn" disabled={busy} onClick={() => void act(() => addToWatchlist(m.norad, tier)).then(() => setQ(""))}>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {/^\d+$/.test(q.trim()) && matches.length === 0 && !watched.has(Number(q.trim())) && (
        <button type="button" className="quiet-btn mt-1.5" disabled={busy} onClick={() => void act(() => addToWatchlist(Number(q.trim()), tier)).then(() => setQ(""))}>
          Look up NORAD {q.trim()} and add
        </button>
      )}
      {err && <p className="mt-1.5 text-[14px] text-rose">{err}</p>}
      {!items && !err && <p className="mt-2 text-[14px] text-muted">Loading…</p>}
      {groups.map(([t, list]) =>
        list.length ? (
          <section key={t} className="mt-4">
            <div className="eyebrow mb-1">
              {t} · {list.length}
            </div>
            <ul className="space-y-0.5">
              {list.map((i) => (
                <li key={i.norad} className="flex items-center gap-2 text-[15px]">
                  <span className="min-w-0 flex-1 truncate" title={i.note ?? undefined}>
                    {i.name}
                    {!i.in_catalog && <span className="text-[14px] text-rose"> (not in catalog)</span>}
                  </span>
                  <select
                    value={i.tier}
                    disabled={busy}
                    onChange={(e) => void act(() => setWatchTier(i.norad, e.target.value as Tier))}
                    className="field w-[100px] px-1.5 py-1 text-[14px]"
                    aria-label={`Tier of ${i.name}`}
                  >
                    {TIERS.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                  <button type="button" className="icon-btn h-8 w-8" disabled={busy} onClick={() => void act(() => removeFromWatchlist(i.norad))} aria-label={`Remove ${i.name}`}>
                    <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      <p className="mt-3 text-[14px] leading-snug text-muted">
        Defaults: ISS and Tiangong (crewed), Hubble (critical), and Indian payloads in LEO from Space-Track SATCAT (COUNTRY = IND) that CelesTrak lists
        as active. Changes apply from the next refresh.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------- tab

export function SentinelTab({
  catalog,
  status,
  replay,
  version,
  onReplay,
  onFocusAlert,
  onClearFocus,
  onNotify,
  top,
  openAlertId = null,
  onOpenedAlert,
}: {
  catalog: CatalogEntry[];
  status: SentinelStatus | null;
  replay: ReplayState | null;
  version: number;
  onReplay: (s: ReplayState | null) => void;
  onFocusAlert: (d: SentinelAlertDetail | null) => void;
  onClearFocus: () => void;
  onNotify: (text: string) => void;
  top: number;
  /** Open this alert on arrival (link from the Fuel tab). */
  openAlertId?: string | null;
  onOpenedAlert?: () => void;
}) {
  const [alerts, setAlerts] = useState<SentinelAlert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [boardOpen, setBoardOpen] = useState(true);
  const [right, setRight] = useState<"detail" | "watchlist" | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SentinelAlertDetail | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [notif, setNotif] = useState<NotificationPermission | "unsupported">("unsupported");
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setNotif(notificationsSupported() ? Notification.permission : "unsupported"), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let live = true;
    fetchSentinelAlerts()
      .then((a) => live && (setAlerts(a), setErr(null)))
      .catch((e) => live && setErr(e instanceof ApiError ? e.message : "Unavailable."));
    return () => {
      live = false;
    };
  }, [version]);

  // Keep the open alert's detail in step with new data.
  useEffect(() => {
    if (!activeId) return;
    let live = true;
    fetchSentinelAlert(activeId)
      .then((d) => live && setDetail(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [version, activeId]);

  const pick = async (a: Pick<SentinelAlert, "id">) => {
    setShowReplay(false);
    setActiveId(a.id);
    setRight("detail");
    setLoadingDetail(true);
    try {
      const d = await fetchSentinelAlert(a.id);
      setDetail(d);
      onFocusAlert(d);
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : "Could not load the alert.");
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    if (!openAlertId) return;
    const t = setTimeout(() => {
      void pick({ id: openAlertId });
      onOpenedAlert?.();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per requested alert
  }, [openAlertId]);

  const doReplay = async () => {
    try {
      const s = await startReplay();
      onReplay(s);
      setShowReplay(true);
      setActiveId(null);
      setDetail(null);
      onClearFocus();
      setRight("detail");
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : "Replay unavailable.");
    }
  };

  const rightTop = top;
  const rightPill2 = rightTop + PILL_HEIGHT + PILL_GAP;
  const panelTop = rightPill2 + PILL_HEIGHT + PILL_GAP;
  const replaying = !!replay?.active || (!!replay?.finished && showReplay);

  return (
    <>
      <SentinelHeader
        status={status}
        replay={replay}
        top={88}
        onRun={() =>
          void runSentinel()
            .then(() => onNotify("Sentinel refresh started."))
            .catch((e) => onNotify(e instanceof ApiError ? e.message : "Could not start."))
        }
        onReplay={() => void doReplay()}
        onStopReplay={() => void stopReplay().then(onReplay).catch(() => undefined)}
        banner={replay?.active || (replay?.finished && showReplay) ? (replay.banner ?? "REPLAY — ESA historical event (anonymised, 2015–2019). Not live.") : null}
        notifState={notif}
        onEnableNotif={() => void Notification.requestPermission().then(setNotif)}
      />
      <AlertBoard
        alerts={alerts}
        err={err}
        activeId={showReplay ? null : activeId}
        onPick={(a) => void pick(a)}
        replay={replay}
        replayActive={showReplay}
        onPickReplay={() => {
          setShowReplay(true);
          setActiveId(null);
          onClearFocus();
          setRight("detail");
        }}
        open={boardOpen}
        onToggle={() => setBoardOpen((o) => !o)}
        top={top}
      />
      <EdgePanel
        side="right"
        label={replaying && showReplay ? "Replay" : "Alert"}
        icon={replaying && showReplay ? Play : BellRing}
        open={right === "detail"}
        onToggle={() => setRight((r) => (r === "detail" ? null : "detail"))}
        top={rightTop}
        panelTop={panelTop}
      >
        {showReplay && replay ? (
          <ReplayDetail r={replay} />
        ) : loadingDetail && !detail ? (
          <p className="flex items-center gap-2 text-[15px]">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Loading…
          </p>
        ) : detail ? (
          <AlertDetail d={detail} />
        ) : (
          <p className="text-[15px]">Pick an alert on the board to see both objects on the globe, the avoidance path, its history and the cost of acting.</p>
        )}
      </EdgePanel>
      <EdgePanel
        side="right"
        label="Watchlist"
        icon={ListChecks}
        open={right === "watchlist"}
        onToggle={() => setRight((r) => (r === "watchlist" ? null : "watchlist"))}
        top={rightPill2}
        panelTop={panelTop}
      >
        <WatchlistEditor catalog={catalog} onChanged={() => onNotify("Watchlist updated. Applies from the next refresh.")} />
      </EdgePanel>
    </>
  );
}
