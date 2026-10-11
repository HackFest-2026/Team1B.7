"use client";

import { useEffect, useState } from "react";
import { ApiError, fetchDecisionRules, type Decision, type DecisionCode, type DecisionRules, type Explanation } from "@/lib/api";
import { PALETTE } from "@/lib/theme";

const TONE: Record<DecisionCode, string> = {
  GO: PALETTE.rose,
  MONITOR: PALETTE.amber,
  WATCH: PALETTE.gold,
  "NO-GO": PALETTE.muted,
};
const SHORT: Record<DecisionCode, string> = { GO: "GO", MONITOR: "Monitor", WATCH: "Watch", "NO-GO": "No-go" };

const fmtUtc = (iso: string) => `${iso.slice(5, 16).replace("T", " ")} UTC`;

/** Muted per-row badge: colour dot + short decision. */
export function DecisionBadge({ d }: { d: Decision }) {
  return (
    <span
      title={`${d.label}${d.provisional ? " (pending avoidance plan)" : ""}. Recommendation — operator decides.`}
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/12 px-2 py-px font-sans text-[14px] text-ivory"
    >
      <span className="h-2 w-2 rounded-full" style={{ background: TONE[d.decision] }} />
      {SHORT[d.decision]}
      {d.provisional && <span className="text-muted">(pending)</span>}
    </span>
  );
}

/** Small tag for an AI flag that physics does not confirm (decision stays NO-GO). */
export function EarlyFlagTag() {
  return (
    <span
      title="AI early flag: the AI model flags this approach, but physics (Pc) does not confirm it. Tracked by Sentinel; not actionable on its own."
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-px text-[14px]"
      style={{ borderColor: `${PALETTE.ice}66`, color: PALETTE.ice }}
    >
      AI early flag
    </span>
  );
}

function FactorBars({ ex }: { ex: Explanation }) {
  return (
    <ul className="mt-1.5 space-y-1.5">
      {ex.factors.map((f) => {
        const isAi = f.key === "ai";
        const color = isAi ? PALETTE.gold : f.effect === "raises" ? PALETTE.rose : f.effect === "lowers" ? PALETTE.ice : PALETTE.muted;
        return (
          <li key={f.key}>
            <div className="flex items-baseline justify-between gap-3 text-[15px]">
              <span className="min-w-0">{f.text}</span>
              {!isAi && f.contribution != null && (
                <span className="shrink-0 font-mono text-[14px] text-muted" title="Change in AI probability vs a typical ESA event">
                  {f.contribution >= 0 ? "+" : "−"}
                  {Math.abs(f.contribution * 100).toFixed(1)} pt
                </span>
              )}
            </div>
            {f.bar != null ? (
              <div className="mt-0.5 h-1 rounded-full bg-white/[0.06]">
                <div className="h-1 rounded-full" style={{ width: `${Math.max(f.bar * 100, 1.5)}%`, background: color, opacity: 0.75 }} />
              </div>
            ) : (
              <div className="text-[14px] text-muted">Not an input of the live AI model.</div>
            )}
            {isAi && f.in_domain === false && <div className="text-[14px] text-muted">Outside the model&apos;s 2–7 day training range.</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** Recommendation for the selected alert. Never executes anything. */
export function DecisionCard({ d, ex }: { d: Decision; ex?: Explanation }) {
  return (
    <div className="mt-3 rounded-xl bg-white/[0.03] px-3 py-3">
      <div className="text-[14px] text-muted">Recommendation — operator decides</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className="font-serif text-[22px] font-semibold leading-tight" style={{ color: d.decision === "NO-GO" ? PALETTE.ivory : TONE[d.decision] }}>
          {d.label}
        </span>
        {d.provisional && <span className="text-[14px] text-muted">pending avoidance plan</span>}
      </div>
      {(d.early_flag || d.stale) && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {d.early_flag && <EarlyFlagTag />}
          {d.stale && (
            <span className="rounded-full border px-2 py-px text-[14px]" style={{ borderColor: `${PALETTE.amber}66`, color: PALETTE.amber }}>
              stale data
            </span>
          )}
        </div>
      )}
      <p className="mt-1 text-[15px] leading-snug">{d.headline}</p>
      {d.recheck_before && (
        <p className="mt-1.5 text-[15px]">
          {d.decision === "GO" ? "Decide before " : "Re-check before "}
          <span className="font-mono">{fmtUtc(d.recheck_before.utc)}</span>
          {d.recheck_before.passed && <span className="text-rose"> (already passed)</span>}
          <span className="block text-[14px] text-muted">{d.recheck_before.basis}</span>
        </p>
      )}
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[14px] leading-snug text-muted">
        {d.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {ex && (
        <>
          <div className="divider my-2.5" />
          <div className="text-[14px] text-muted">Why</div>
          <FactorBars ex={ex} />
          <p className="mt-1.5 text-[14px] leading-snug text-muted">
            Bars: how far each factor moves the AI probability from a typical ESA event (input set to its training median); rose
            raises it, blue lowers it. AI bar: the probability itself (model est.).
          </p>
        </>
      )}
      <p className="mt-1.5 text-[14px] text-muted">{d.note}</p>
    </div>
  );
}

const fmtCfg = (k: string, v: number | null) => {
  if (v === null) return "—";
  if (k.endsWith("_days")) return `${v} d`;
  if (k.endsWith("_km")) return `${v} km`;
  if (k === "confirm_updates") return `${v}`;
  if (k.endsWith("_ms")) return `${v} m/s`;
  if (k === "ai_p_high_threshold") return `${(v * 100).toFixed(2)}%`;
  if (k.startsWith("latest_burn")) return `${v} orbit`;
  return v.toExponential(0).replace("e-", "e−");
};

const CFG_LABEL: Record<string, string> = {
  go_pc: "GO: Pc at least",
  go_ai_final_risk: "GO: AI final risk at least",
  watch_pc: "WATCH: Pc at least",
  watch_ai_min_pc: "WATCH: AI flag backed by Pc at least",
  ai_p_high_threshold: "AI early flag: P(high-risk) at least",
  tle_stale_days: "Stale data: TLE older than",
  stale_watch_miss_km: "WATCH on stale data: miss under",
  confirm_updates: "CONFIRMED GO: consecutive updates",
  confirm_ai_final_risk: "CONFIRMED GO: or AI final risk at least",
  avoid_target_pc: "Valid option: Pc below",
  deadline_max_dv_ms: "Deadline: option Δv at most",
  latest_burn_orbits_before_tca: "Latest burn slot before TCA",
};

/** "Decision rules": the thresholds config from backend/decision.py. */
export function DecisionRulesSection() {
  const [r, setR] = useState<DecisionRules | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchDecisionRules()
      .then(setR)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Unavailable."));
  }, []);
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[14px] text-muted hover:text-gold">Decision rules</summary>
      {err && <p className="mt-1 text-[14px] text-rose">{err}</p>}
      {r && (
        <div className="mt-1.5">
          {r.stages && (
            <ol className="mb-3 space-y-1.5">
              {r.stages.map((st) => (
                <li key={st.stage} className="rounded-lg bg-white/[0.03] px-2.5 py-2 text-[14px] leading-snug">
                  <span className="font-semibold text-gold">
                    Stage {st.stage} · {st.title}
                  </span>
                  <span className="mt-0.5 block text-ivory">{st.when}</span>
                </li>
              ))}
            </ol>
          )}
          <ul className="space-y-1.5">
            {r.rules.map((x) => (
              <li key={x.decision} className="text-[14px] leading-snug">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: TONE[x.decision] }} />
                <span className="font-semibold text-ivory">{x.label}:</span> <span className="text-ivory">{x.when}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2">
            {Object.entries(r.config).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3 py-[2px]">
                <span className="text-[14px] text-muted">{CFG_LABEL[k] ?? k}</span>
                <span className="font-mono text-[14px] text-ivory">{fmtCfg(k, v)}</span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[14px] leading-snug text-muted">
            {r.deadline} {r.ai_note} {r.note}
          </p>
        </div>
      )}
    </details>
  );
}
