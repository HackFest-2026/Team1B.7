"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  ApiError,
  fetchAbout,
  fetchModelMetrics,
  fmtSci,
  type AboutConfig,
  type CalibrationBin,
  type ComparisonModel,
  type DecisionLevels,
  type EvalSet,
  type ImportanceRow,
  type Interval,
  type Kpis,
  type LeadRow,
  type ModelComparison,
  type ModelMetrics,
} from "@/lib/api";
import { PALETTE } from "@/lib/theme";
import { DASH, Glass } from "../hud/Glass";

const SET_LABEL: Record<EvalSet, string> = { holdout: "Held-out", official_test: "Official ESA test" };
const SETS: EvalSet[] = ["holdout", "official_test"];

const FEATURE_LABEL: Record<string, string> = {
  log10_pc: "Collision probability (log10)",
  miss_over_sigma: "Miss distance ÷ σ",
  sigma_km: "Position uncertainty σ",
  relative_speed_ms: "Relative speed",
  miss_distance_m: "Miss distance",
  time_to_tca_d: "Time to closest approach",
  object_type: "Other object's type",
  radial_sep_m: "Radial separation",
};

// --------------------------------------------------------------------------- formatting

const isNum = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const fix = (v: number | null | undefined, d: number) => (isNum(v) ? v.toFixed(d) : DASH);
const pct = (v: number | null | undefined, d = 1) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : DASH);
const int = (v: number | null | undefined) => (isNum(v) ? v.toLocaleString("en-US") : DASH);
const sci = (v: number) => v.toExponential(0).replace("e-", "e−");
const signed = (v: number | null, d: number) => (v === null ? DASH : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`);
const ci = (iv: Interval | undefined, d: number) => (!iv || iv.lo === null || iv.hi === null ? DASH : `${signed(iv.lo, d)} to ${signed(iv.hi, d)}`);

// --------------------------------------------------------------------------- building blocks

function Label({ children }: { children: ReactNode }) {
  return <h2 className="label-caps mb-3">{children}</h2>;
}

function Section({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <Label>{label}</Label>
      {children}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-3 max-w-[70ch] text-[14px] leading-snug text-muted">{children}</p>;
}

function Th({ children, right = false, span }: { children?: ReactNode; right?: boolean; span?: number }) {
  return (
    <th colSpan={span} className={`pb-1.5 pr-4 text-[14px] font-medium text-muted ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({ children, mono = true, dim = false, sub }: { children: ReactNode; mono?: boolean; dim?: boolean; sub?: ReactNode }) {
  return (
    <td className={`py-2 pr-4 align-top ${mono ? "text-right font-mono" : ""} ${dim ? "text-ivory/70" : "text-ivory"}`}>
      {children}
      {sub !== undefined && <span className="ml-1.5 font-mono text-[14px] text-muted">{sub}</span>}
    </td>
  );
}

function StatBlock({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub: ReactNode }) {
  return (
    <Glass className="p-5">
      <div className="label-caps">{label}</div>
      <div className="mt-3 font-mono text-[32px] leading-none text-ivory">
        {value}
        {unit && <span className="ml-1 text-[17px] text-muted">{unit}</span>}
      </div>
      <div className="mt-2 text-[14px] leading-snug text-muted">{sub}</div>
    </Glass>
  );
}

// --------------------------------------------------------------------------- 2. KPI row

function KpiRow({ m, dl, k }: { m: ModelMetrics; dl: DecisionLevels; k: Kpis }) {
  const off = dl.by_set.official_test;
  const ho = dl.by_set.holdout;
  const ef = off.early_flag;
  const w = off.watch_or_above;
  const r = m.results.holdout;
  const briefCi = m.intervals.holdout.vs_baseline.live.brier;
  const tp = k.throughput;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatBlock
        label="Recall · ESA test · early flag"
        value={pct(ef.recall)}
        sub={
          <>
            {ef.tp} of {ef.tp + ef.fn} high-risk events, official ESA test
          </>
        }
      />
      <StatBlock
        label="False alerts · WATCH level"
        value={pct(w.false_alert_rate)}
        sub={
          <>
            {w.fp} of {int(w.fp + w.tn)} low-risk events, official test; held-out {pct(ho.watch_or_above.false_alert_rate)}
          </>
        }
      />
      <StatBlock
        label="Brier vs baseline · held-out"
        value={fix(r.live.brier, 4)}
        sub={
          <>
            Baseline {fix(r.baseline.brier, 4)}; lower is better. 95% CI of difference {ci(briefCi, 4)}
          </>
        }
      />
      <StatBlock
        label="Watchlist screening time"
        value={tp?.watchlist ? tp.watchlist.seconds.toFixed(0) : DASH}
        unit="s"
        sub={
          tp?.watchlist ? (
            <>
              {tp.watchlist.objects} objects vs {int(tp.catalog_objects)}, {tp.horizon_h} h ahead, one core. Measured {tp.measured_utc.slice(0, 10)}
            </>
          ) : (
            "Not measured: run python ml.py throughput"
          )
        }
      />
    </div>
  );
}

// --------------------------------------------------------------------------- 3. two-stage alert table

function StageTable({ dl, hr }: { dl: DecisionLevels; hr: string }) {
  const t = dl.thresholds;
  const rows = [
    { key: "early_flag" as const, stage: "Stage 1", name: "AI early flag", rule: `AI P(high-risk) ≥ ${fix(t.ai_p_high_threshold, 4)}` },
    {
      key: "watch_or_above" as const,
      stage: "Stage 2",
      name: "WATCH or above",
      rule: `Pc ≥ ${sci(t.watch_pc)}, or flag and Pc ≥ ${sci(t.watch_ai_min_pc)}`,
    },
  ];
  return (
    <Glass className="overflow-x-auto p-6">
      <table className="w-full min-w-[640px] text-[15px]">
        <thead>
          <tr>
            <Th />
            {SETS.map((ds) => (
              <Th key={ds} right span={2}>
                {SET_LABEL[ds]} · {int(dl.by_set[ds].n)} events, {dl.by_set[ds].n_high_risk} high-risk
              </Th>
            ))}
          </tr>
          <tr>
            <Th>Level</Th>
            {SETS.map((ds) => (
              <Fragment key={ds}>
                <Th right>Recall</Th>
                <Th right>False alerts</Th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="divider">
              <Td mono={false}>
                <span className="font-semibold">{row.stage}</span> · {row.name}
                <div className="font-mono text-[14px] text-muted">{row.rule}</div>
              </Td>
              {SETS.map((ds) => {
                const c = dl.by_set[ds][row.key];
                return (
                  <Fragment key={ds}>
                    <Td sub={`${c.tp}/${c.tp + c.fn}`}>{pct(c.recall)}</Td>
                    <Td sub={`${c.fp}`}>{pct(c.false_alert_rate)}</Td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Note>
        Truth: ESA final risk ≥ {hr}. False alerts: share of low-risk events alerted. Stage 1 only tags an approach; WATCH needs
        Pc to back it. ESA CDMs carry no element-set age, so the stale-data rule never fires here.
      </Note>
    </Glass>
  );
}

// --------------------------------------------------------------------------- 4. model comparison

const CMP_ROWS: { key: ComparisonModel; label: string; inputs: string }[] = [
  { key: "trees_live", label: "Gradient-boosted trees", inputs: "live inputs, latest CDM" },
  { key: "lstm_live", label: "LSTM", inputs: "live inputs, CDM sequence" },
  { key: "trees_full", label: "Gradient-boosted trees", inputs: "all CDM columns + trends" },
  { key: "lstm_full", label: "LSTM", inputs: "all CDM columns, sequence" },
  { key: "baseline", label: "Baseline", inputs: "latest risk carried forward" },
];
const CMP_COLS = [
  { key: "brier", label: "Brier", fmt: (v: number) => fix(v, 4) },
  { key: "recall", label: "Recall", fmt: (v: number) => pct(v) },
  { key: "false_alert_rate", label: "False alerts", fmt: (v: number) => pct(v) },
  { key: "pr_auc", label: "PR-AUC", fmt: (v: number) => fix(v, 3) },
] as const;

function ComparisonTable({ mc, treesUtc, hr, target }: { mc: ModelComparison; treesUtc: string; hr: string; target: string }) {
  const liveKey: ComparisonModel = mc.live_model === "lstm" ? "lstm_live" : "trees_live";
  return (
    <Glass className="overflow-x-auto p-6">
      <table className="w-full min-w-[760px] text-[15px]">
        <thead>
          <tr>
            <Th />
            {SETS.map((ds) => (
              <Th key={ds} right span={CMP_COLS.length}>
                {SET_LABEL[ds]}
              </Th>
            ))}
          </tr>
          <tr>
            <Th>Model</Th>
            {SETS.map((ds) => (
              <Fragment key={ds}>
                {CMP_COLS.map((c) => (
                  <Th key={c.key} right>
                    {c.label}
                  </Th>
                ))}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {CMP_ROWS.map((row) => (
            <tr key={row.key} className="divider">
              <Td mono={false} dim={row.key === "baseline"}>
                {row.label}
                {row.key === liveKey && <span className="ml-2 text-[14px] font-semibold text-gold">live</span>}
                <div className="text-[14px] text-muted">{row.inputs}</div>
              </Td>
              {SETS.map((ds) => (
                <Fragment key={ds}>
                  {CMP_COLS.map((c) => {
                    const v = mc.results[ds][row.key]?.[c.key];
                    return (
                      <Td key={c.key} dim={row.key === "baseline"}>
                        {isNum(v) ? c.fmt(v) : DASH}
                      </Td>
                    );
                  })}
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Note>
        {mc.reason} LSTM − trees Brier, 95% CI (live inputs): held-out {ci(mc.diff_ci.holdout.lstm_live_vs_trees_live.brier, 4)}, official{" "}
        {ci(mc.diff_ci.official_test.lstm_live_vs_trees_live.brier, 4)}. Recall and false alerts at each model&apos;s own threshold for ≥ {target}
        validation recall. Baseline Brier uses its yes/no rule (risk ≥ {hr}).
        {mc.trees_trained_utc !== treesUtc && " Trees retrained after this benchmark; rerun python ml.py lstm."}
      </Note>
    </Glass>
  );
}

// --------------------------------------------------------------------------- 5. charts

const AXIS = "rgb(255 255 255 / 0.08)";
const MODEL_COLOR = PALETTE.gold;
const BASE_COLOR = PALETTE.ice;

/** Reliability diagram on square-root axes (most predictions are small). One series: the live model. */
function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const S = 300;
  const P = 40;
  const inner = S - P - 14;
  const sx = (v: number) => P + Math.sqrt(Math.max(0, Math.min(1, v))) * inner;
  const sy = (v: number) => 14 + inner - Math.sqrt(Math.max(0, Math.min(1, v))) * inner;
  const ticks = [0, 0.05, 0.2, 0.5, 1];
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="h-auto w-full max-w-[360px]" role="img" aria-label="Calibration: predicted probability vs observed rate, held-out events">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P} x2={P + inner} y1={sy(t)} y2={sy(t)} stroke={AXIS} />
          <line x1={sx(t)} x2={sx(t)} y1={14} y2={14 + inner} stroke={AXIS} />
          <text x={sx(t)} y={S - 8} fill={PALETTE.muted} fontSize="13" textAnchor="middle" fontFamily="var(--font-geist-mono)">
            {t}
          </text>
          <text x={P - 6} y={sy(t) + 4} fill={PALETTE.muted} fontSize="13" textAnchor="end" fontFamily="var(--font-geist-mono)">
            {t}
          </text>
        </g>
      ))}
      <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke={PALETTE.muted} strokeOpacity={0.6} strokeDasharray="3 5" />
      <polyline points={bins.map((b) => `${sx(b.mean_predicted)},${sy(b.observed_rate)}`).join(" ")} fill="none" stroke={MODEL_COLOR} strokeWidth={2} />
      {bins.map((b) => (
        <g key={b.bin}>
          <circle cx={sx(b.mean_predicted)} cy={sy(b.observed_rate)} r={Math.max(4, Math.min(8, Math.sqrt(b.n) / 3))} fill={MODEL_COLOR} stroke="#05060A" strokeWidth={2} />
          {/* larger invisible hit target for the hover tooltip */}
          <circle cx={sx(b.mean_predicted)} cy={sy(b.observed_rate)} r={12} fill="transparent">
            <title>{`P ${b.bin}: predicted ${b.mean_predicted.toFixed(3)}, observed ${b.observed_rate.toFixed(3)} (${b.positives} of ${b.n})`}</title>
          </circle>
        </g>
      ))}
    </svg>
  );
}

/** Small multiples over lead time (recall, false-alert rate): live model vs baseline, one axis each. */
function LeadChart({ rows, metric, title }: { rows: LeadRow[]; metric: "recall" | "false_alert_rate"; title: string }) {
  const W = 340;
  const H = 128;
  const L = 44;
  const R = 70;
  const T = 10;
  const B = 24;
  const vals = rows.flatMap((r) => [r.live[metric], r.baseline[metric]]);
  const lo = metric === "recall" ? Math.min(0.6, ...vals) : 0;
  const hi = metric === "recall" ? 1 : Math.max(0.1, ...vals);
  const sx = (i: number) => L + (i * (W - L - R)) / Math.max(1, rows.length - 1);
  const sy = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo, (lo + hi) / 2, hi];
  const series = [
    { key: "live" as const, name: "Model", color: MODEL_COLOR, dash: undefined, hollow: false },
    { key: "baseline" as const, name: "Baseline", color: BASE_COLOR, dash: "5 4", hollow: true },
  ];
  return (
    <figure>
      <figcaption className="mb-1 text-[14px] text-muted">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title} by lead time, model vs baseline`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} stroke={AXIS} />
            <text x={L - 6} y={sy(t) + 4} fill={PALETTE.muted} fontSize="13" textAnchor="end" fontFamily="var(--font-geist-mono)">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {rows.map((r, i) => (
          <text key={r.days} x={sx(i)} y={H - 6} fill={PALETTE.muted} fontSize="13" textAnchor="middle" fontFamily="var(--font-geist-mono)">
            {r.label.replace("≥ ", "≥")}
          </text>
        ))}
        {series.map((s) => {
          const last = rows[rows.length - 1];
          return (
            <g key={s.key}>
              <polyline
                points={rows.map((r, i) => `${sx(i)},${sy(r[s.key][metric])}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dash}
              />
              {rows.map((r, i) => (
                <g key={r.days}>
                  <circle cx={sx(i)} cy={sy(r[s.key][metric])} r={4} fill={s.hollow ? "#05060A" : s.color} stroke={s.color} strokeWidth={2} />
                  <circle cx={sx(i)} cy={sy(r[s.key][metric])} r={11} fill="transparent">
                    <title>{`${s.name}, inputs ${r.label} before TCA: ${pct(r[s.key][metric])} (${r.n_high_risk} high-risk of ${r.n.toLocaleString("en-US")} events)`}</title>
                  </circle>
                </g>
              ))}
              {last && (
                <text x={W - R + 8} y={sy(last[s.key][metric]) + 4} fill={PALETTE.ivory} fontSize="13" fontFamily="var(--font-geist-mono)">
                  {s.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-muted">
      <span className="flex items-center gap-2">
        <svg width="22" height="8" aria-hidden>
          <line x1="0" y1="4" x2="22" y2="4" stroke={MODEL_COLOR} strokeWidth="2" />
        </svg>
        Model (live, trees)
      </span>
      <span className="flex items-center gap-2">
        <svg width="22" height="8" aria-hidden>
          <line x1="0" y1="4" x2="22" y2="4" stroke={BASE_COLOR} strokeWidth="2" strokeDasharray="5 4" />
        </svg>
        Baseline (latest risk)
      </span>
    </div>
  );
}

// --------------------------------------------------------------------------- 6. features

function FeatureBars({ rows }: { rows: ImportanceRow[] }) {
  const max = Math.max(...rows.map((r) => r.importance), 1e-9);
  return (
    <table className="w-full text-[15px]">
      <thead>
        <tr>
          <Th>Input</Th>
          <Th right>Δ Brier when shuffled</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.feature} className="divider">
            <Td mono={false}>{FEATURE_LABEL[r.feature] ?? r.feature}</Td>
            <Td>{r.importance > 0 ? r.importance.toExponential(1).replace("e-", "e−") : "≈ 0"}</Td>
            <td className="w-[38%] py-2 align-middle">
              <div className="h-1.5 rounded-full bg-white/[0.06]">
                <div className="h-1.5 rounded-full bg-gold/80" style={{ width: `${Math.max(0, (r.importance / max) * 100)}%` }} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --------------------------------------------------------------------------- page

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="w-full text-[15px]">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="divider">
            <td className="w-[38%] py-2 pr-4 align-top text-muted">{k}</td>
            <td className="py-2 align-top text-ivory">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ModelTab() {
  const [m, setM] = useState<ModelMetrics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<AboutConfig | null>(null);

  useEffect(() => {
    fetchAbout()
      .then(setCfg)
      .catch(() => undefined); // configured values fall back to a dash
    fetchModelMetrics()
      .then(setM)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Could not load the model report."));
  }, []);

  const k = m?.kpis;
  const dl = k?.decision_levels;
  const d = m?.dataset;
  const sp = m?.split;
  const hp = m?.hyperparameters?.live;
  const hpNum = (key: string) => (typeof hp?.[key] === "number" ? String(hp[key]) : DASH);
  const offBrier = m?.intervals.official_test.vs_baseline.live.brier;
  const ai = cfg?.ai;
  const hr = ai ? fmtSci(ai.high_risk_pc) : DASH;
  const target = k ? `${Math.round(k.operating_point.target_recall * 100)}%` : DASH;
  const offTie = offBrier && offBrier.lo !== null && offBrier.hi !== null && offBrier.lo <= 0 && offBrier.hi >= 0;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="font-serif text-[44px] font-semibold leading-tight">Model</h1>
        <p className="mt-2 max-w-[70ch] text-[17px] text-ivory">
          Predicts, from the conjunction data available {ai?.min_tca_days ?? DASH} or more days before closest approach, the
          probability that the event&apos;s final collision risk will be at least {hr}.
        </p>
      </header>

      {err && <p className="text-[17px] text-rose">{err}</p>}
      {!m && !err && <p className="text-[17px] text-muted">Loading metrics…</p>}

      {m && k && dl && d && sp && (
        <>
          <Section label="Key results">
            <KpiRow m={m} dl={dl} k={k} />
          </Section>

          <Section label="Two-stage alerts">
            <StageTable dl={dl} hr={hr} />
          </Section>

          {m.model_comparison && (
            <Section label="Model comparison">
              <ComparisonTable mc={m.model_comparison} treesUtc={m.generated_utc} hr={hr} target={target} />
            </Section>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <Section label="Calibration · held-out">
              <Glass className="p-6">
                <CalibrationChart bins={m.calibration.holdout.live} />
                <Note>
                  Predicted P(high-risk) vs observed rate. Dashed: perfect calibration. Square-root axes; dot size ∝ events. Official test
                  over-represents high-risk events ({pct(d.official_test_high_risk_events / d.official_test_events)} vs{" "}
                  {pct(d.train_high_risk_events / d.train_events_eligible, 2)}), so it is not used here.
                </Note>
              </Glass>
            </Section>
            <Section label="Lead time · official test">
              <Glass className="p-6">
                <LeadChart rows={k.lead_time.rows.official_test} metric="recall" title="Recall" />
                <div className="h-3" />
                <LeadChart rows={k.lead_time.rows.official_test} metric="false_alert_rate" title="False-alert rate" />
                <Legend />
                <Note>
                  Inputs limited to CDMs at least this many days before closest approach; thresholds fixed. Model at its early-flag
                  threshold; baseline at risk ≥ {hr}.
                </Note>
              </Glass>
            </Section>
          </div>

          <Section label="Top 8 features">
            <Glass className="p-6">
              <FeatureBars rows={m.importance.live.slice(0, 8)} />
              <Note>Permutation importance on held-out events: rise in Brier score when one input is shuffled.</Note>
            </Glass>
          </Section>

          <Section label="Data">
            <Glass className="p-6">
              <KV
                rows={[
                  [
                    "Source",
                    <a key="src" href={d.url} target="_blank" rel="noreferrer" className="text-gold underline-offset-4 hover:underline">
                      ESA Kelvins Collision Avoidance Challenge
                    </a>,
                  ],
                  ["Content", `Conjunction Data Messages (CDMs), ${d.years}, anonymised`],
                  ["Events", `${int(d.train_events)} training · ${int(d.train_events_eligible)} usable · ${int(d.official_test_events)} official test`],
                  [
                    "High-risk share",
                    `${d.train_high_risk_events} of ${int(d.train_events_eligible)} usable (${pct(d.train_high_risk_events / d.train_events_eligible, 2)}) · official test ${d.official_test_high_risk_events} of ${int(d.official_test_events)} (${pct(d.official_test_high_risk_events / d.official_test_events)})`,
                  ],
                  [
                    `Split by event, seed ${sp.seed}`,
                    `train ${int(sp.train_events)} (${sp.train_high_risk}) · validation ${int(sp.validation_events)} (${sp.validation_high_risk}) · held-out ${int(sp.holdout_events)} (${sp.holdout_high_risk})`,
                  ],
                ]}
              />
              <Note>Parentheses: high-risk events (final risk ≥ {hr}). An event never appears in two splits.</Note>
            </Glass>
          </Section>

          <Section label="Method">
            <ul className="max-w-[70ch] space-y-1.5 text-[17px] text-ivory">
              <li>
                <span className="text-muted">Features:</span> {m.live_features?.length ?? m.n_features.live} live-screener quantities from the
                latest CDM ≥ {ai?.min_tca_days ?? DASH} d before TCA.
              </li>
              <li>
                <span className="text-muted">Model:</span> gradient-boosted trees (HistGradientBoosting), depth {hpNum("clf_depth")},{" "}
                {hpNum("clf_iters")} iterations.
              </li>
              <li>
                <span className="text-muted">Calibration:</span> isotonic, {ai?.calibration_folds ?? DASH}-fold cross-fitted on training events.
              </li>
              <li>
                <span className="text-muted">Threshold:</span> <span className="font-mono">{fix(m.thresholds.live, 4)}</span>, the highest
                P(high-risk) catching ≥ {target} of high-risk validation events.
              </li>
            </ul>
          </Section>

          <Section label="Limits">
            <ul className="max-w-[70ch] list-disc space-y-1.5 pl-5 text-[17px] text-ivory marker:text-muted">
              <li>
                Trained on ESA probabilities with full covariance. Live Pc uses an assumed isotropic σ from element-set age, so live
                AI risk is an approximation (est.).
              </li>
              <li>
                Few positives: {sp.train_high_risk} high-risk training events, {sp.holdout_high_risk} held-out. Intervals are wide.
              </li>
              <li>
                Official test Brier: model {fix(m.results.official_test.live.brier, 4)}, baseline {fix(m.results.official_test.baseline.brier, 4)}
                {offTie ? "; the 95% CI of the difference includes zero, so no improvement is shown there." : "."}
              </li>
              <li>
                Trained on approaches {ai?.min_tca_days ?? DASH}–{ai?.max_tca_days ?? DASH} days before TCA. Outside that range AI risk is
                marked out of domain.
              </li>
              <li>
                Stage 1 flags {pct(dl.by_set.official_test.early_flag.false_alert_rate)} of low-risk events on the official test, so it
                only tags; it never raises WATCH alone.
              </li>
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}
