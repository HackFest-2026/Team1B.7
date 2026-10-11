"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  planAvoidance,
  type AvoidCandidate,
  type AvoidResponse,
  type CatalogEntry,
  type Conjunction,
  type OfficialType,
} from "@/lib/api";
import { PALETTE } from "@/lib/theme";
import { FuelBreakdown, fmtDvUnit, fmtMass } from "./FuelBreakdown";
import { DASH } from "./Glass";

const DEFAULT_MASS = 500;
const DEFAULT_ISP = 220;
const DEFAULT_TANK_FRACTION = 0.1; // assumed; mirrors maneuver_opt.DEFAULT_TANK_FRACTION (placeholder text only)
const DEFAULT_SK = 10; // m/s per year, assumed; mirrors maneuver_opt.DEFAULT_SK_MS_PER_YEAR (placeholder text only)
const TARGETS = [1e-4, 1e-5, 1e-6, 1e-7];
const FAMILY_COLOR: Record<string, string> = { T: PALETTE.ice, R: PALETTE.silver, N: PALETTE.amber };
const FAMILY_LABEL: Record<string, string> = { T: "Along-track", R: "Radial", N: "Cross-track" };

const fmtPc = (pc: number) => (pc < 1e-12 ? "< 1e−12" : pc.toExponential(1).replace("e-", "e−"));
const fmtDv = (ms: number) => `${ms.toPrecision(3)} m/s`;
const fmtUtc = (iso: string) => `${iso.slice(5, 16).replace("T", " ")} UTC`;

interface Params {
  mass?: number;
  isp?: number;
  tank?: number;
  sk?: number;
  target: number;
}

/** Residual Pc (log) vs Δv (log) for every candidate; recommended highlighted, rejected hollow, target dashed. */
function ParetoChart({ plan }: { plan: AvoidResponse }) {
  const cands = plan.candidates ?? [];
  const target = plan.target_pc ?? 1e-5;
  const base = plan.baseline?.pc ?? target;
  const recId = plan.recommended?.id;
  const W = 280;
  const H = 210;
  const L = 50;
  const R = 8;
  const T = 10;
  const B = 36;
  const xs = [Math.log10(0.005), Math.log10(2)];
  const finiteLogs = cands.filter((c) => c.new_pc > 0).map((c) => Math.log10(c.new_pc));
  const lo = Math.max(-12, Math.floor(Math.min(...finiteLogs, Math.log10(target) - 1)));
  const hi = Math.ceil(Math.max(...finiteLogs, Math.log10(base), Math.log10(target)) + 0.2);
  const sx = (dv: number) => L + ((Math.log10(dv) - xs[0]) / (xs[1] - xs[0])) * (W - L - R);
  const sy = (pc: number) => {
    const v = pc > 0 ? Math.max(lo, Math.log10(pc)) : lo;
    return T + ((hi - v) / (hi - lo)) * (H - T - B);
  };
  const step = hi - lo > 8 ? 2 : 1;
  const yt: number[] = [];
  for (let d = lo; d <= hi; d += step) yt.push(d);

  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Residual collision probability versus delta-v for ${cands.length} candidate burns`}>
        {yt.map((d) => (
          <g key={d}>
            <line x1={L} x2={W - R} y1={sy(10 ** d)} y2={sy(10 ** d)} stroke="rgb(255 255 255 / 0.06)" />
            <text x={L - 5} y={sy(10 ** d) + 4} fill={PALETTE.muted} fontSize="14" textAnchor="end" fontFamily="var(--font-geist-mono)">
              1e{d}
            </text>
          </g>
        ))}
        {[0.01, 0.1, 1].map((v) => (
          <g key={v}>
            <line x1={sx(v)} x2={sx(v)} y1={T} y2={H - B} stroke="rgb(255 255 255 / 0.06)" />
            <text x={sx(v)} y={H - B + 16} fill={PALETTE.muted} fontSize="14" textAnchor="middle" fontFamily="var(--font-geist-mono)">
              {v}
            </text>
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 2} fill={PALETTE.muted} fontSize="14" textAnchor="middle">
          Δv (m/s, log)
        </text>
        <line x1={L} x2={W - R} y1={sy(base)} y2={sy(base)} stroke={PALETTE.muted} strokeDasharray="1 4" />
        <line x1={L} x2={W - R} y1={sy(target)} y2={sy(target)} stroke={PALETTE.ivory} strokeOpacity={0.7} strokeDasharray="5 4" />
        <text x={W - R} y={sy(target) - 4} fill={PALETTE.ivory} fontSize="14" textAnchor="end">
          target
        </text>
        {cands.map((c) =>
          c.constraint === "rejected" ? (
            <circle key={c.id} cx={sx(c.dv_ms)} cy={sy(c.new_pc)} r={3.4} fill="none" stroke={PALETTE.rose} strokeWidth={1.2}>
              <title>{`${c.direction_label}, ${fmtDv(c.dv_ms)}, ${c.orbits_before} orbits before: rejected (new conjunction)`}</title>
            </circle>
          ) : (
            <circle key={c.id} cx={sx(c.dv_ms)} cy={sy(c.new_pc)} r={2.1} fill={FAMILY_COLOR[c.direction[1]]} fillOpacity={0.55}>
              <title>{`${c.direction_label}, ${fmtDv(c.dv_ms)}, ${c.orbits_before} orbits before: Pc ${fmtPc(c.new_pc)}`}</title>
            </circle>
          ),
        )}
        {recId &&
          cands
            .filter((c) => c.id === recId)
            .map((c) => (
              <g key="rec">
                <circle cx={sx(c.dv_ms)} cy={sy(c.new_pc)} r={8} fill="none" stroke={PALETTE.gold} strokeWidth={1.2} />
                <circle cx={sx(c.dv_ms)} cy={sy(c.new_pc)} r={4} fill={PALETTE.gold} />
              </g>
            ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[14px] text-muted">
        {(["T", "R", "N"] as const).map((f) => (
          <span key={f} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: FAMILY_COLOR[f] }} />
            {FAMILY_LABEL[f]}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border border-rose" /> Rejected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-gold" /> Recommended
        </span>
        <span>Dotted: Pc now. Lower Pc floored at 1e{lo}.</span>
      </figcaption>
    </figure>
  );
}

function Fig({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[14px] text-muted">{label}</span>
      <span className="text-right font-mono text-[15px] text-ivory">
        {value}
        {sub && <span className="ml-1.5 text-[14px] text-muted">{sub}</span>}
      </span>
    </div>
  );
}

/**
 * "Avoidance": collision-avoidance manoeuvre plan for the payload in this conjunction (POST /avoid).
 * Every figure is an estimate under the assumptions listed in the panel.
 */
export function AvoidancePanel({
  c,
  primary,
  secondaryType,
  showPath,
  onShowPath,
  onPlan,
}: {
  c: Conjunction;
  primary: CatalogEntry | null;
  secondaryType: OfficialType;
  showPath: boolean;
  onShowPath: (v: boolean) => void;
  onPlan: (plan: AvoidResponse | null) => void;
}) {
  const [massIn, setMassIn] = useState("");
  const [ispIn, setIspIn] = useState("");
  const [tankIn, setTankIn] = useState("");
  const [skIn, setSkIn] = useState("");
  const [targetIn, setTargetIn] = useState(1e-5);
  const [params, setParams] = useState<Params>({ target: 1e-5 });
  const [inputErr, setInputErr] = useState<string | null>(null);
  const canMove = primary?.object_type === "PAYLOAD" || secondaryType === "PAYLOAD";

  const key = `${c.primary_norad}|${c.norad}|${c.tca_utc}|${params.mass ?? ""}|${params.isp ?? ""}|${params.tank ?? ""}|${params.sk ?? ""}|${params.target}`;
  const [store, setStore] = useState<{ key: string; plan?: AvoidResponse; err?: string } | null>(null);
  const cur = store?.key === key ? store : null;

  useEffect(() => {
    if (!canMove) return;
    let alive = true;
    planAvoidance({
      primary: c.primary_norad,
      secondary: c.norad,
      tca: c.tca_utc,
      target_pc: params.target,
      ...(params.mass ? { mass_kg: params.mass } : {}),
      ...(params.isp ? { isp_s: params.isp } : {}),
      ...(params.tank ? { tank_kg: params.tank } : {}),
      ...(params.sk ? { stationkeeping_ms_per_year: params.sk } : {}),
    })
      .then((plan) => {
        if (!alive) return;
        setStore({ key, plan });
        onPlan(plan);
      })
      .catch((e) => alive && setStore({ key, err: e instanceof ApiError ? e.message : "Could not plan a manoeuvre." }));
    return () => {
      alive = false;
    };
  }, [key, canMove, c.primary_norad, c.norad, c.tca_utc, params, onPlan]);

  useEffect(() => () => onPlan(null), [onPlan]);

  const rerun = () => {
    const mass = massIn.trim() ? Number(massIn) : undefined;
    const isp = ispIn.trim() ? Number(ispIn) : undefined;
    const tank = tankIn.trim() ? Number(tankIn) : undefined;
    const sk = skIn.trim() ? Number(skIn) : undefined;
    if ((mass !== undefined && !(mass > 0 && mass <= 1e6)) || (isp !== undefined && !(isp > 0 && isp <= 1e4))) {
      setInputErr("Mass must be 0–1,000,000 kg and Isp 0–10,000 s.");
      return;
    }
    if ((tank !== undefined && !(tank > 0 && tank <= 1e6)) || (sk !== undefined && !(sk > 0 && sk <= 1000))) {
      setInputErr("Tank must be 0–1,000,000 kg and station-keeping 0–1,000 m/s per year.");
      return;
    }
    setInputErr(null);
    setParams({ mass, isp, tank, sk, target: targetIn });
  };

  const plan = cur?.plan;
  const rec = plan?.recommended ?? null;
  const counts = useMemo(() => {
    const cs: AvoidCandidate[] = plan?.candidates ?? [];
    return { total: cs.length, meeting: cs.filter((x) => x.meets_target).length };
  }, [plan]);

  return (
    <div className="mt-3 rounded-xl bg-white/[0.03] px-3 py-3">
      <h4 className="font-serif text-[19px] font-semibold">Avoidance</h4>

      {!canMove && <p className="mt-1 text-[15px]">No manoeuvre possible: neither object can manoeuvre.</p>}
      {canMove && !cur && (
        <p className="mt-1 flex items-center gap-2 text-[14px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Searching 600 burns and re-screening the best against the
          catalog (about 20 s)…
        </p>
      )}
      {cur?.err && <p className="mt-1 text-[14px] text-rose">{cur.err}</p>}

      {plan && !plan.possible && <p className="mt-1 text-[15px]">{plan.reason}</p>}

      {plan?.possible && plan.maneuvering && plan.baseline && (
        <>
          <p className="mt-1 text-[14px] text-muted">
            Burn by <span className="text-ivory">{plan.maneuvering.name}</span> (payload)
            {plan.maneuvering.role === "secondary" && "; the protected object cannot manoeuvre, so this plans for the other object"}.
          </p>

          {rec ? (
            <div className="mt-2">
              <div className="text-[14px] text-muted">Recommended burn (est.)</div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-[28px] leading-tight text-gold">{fmtDvUnit(rec.dv_ms)}</span>
                <span className="text-[17px]">{rec.direction_label}</span>
              </div>
              <Fig label="Burn time" value={fmtUtc(rec.burn_utc)} sub={`T−${rec.lead_h.toFixed(2)} h`} />
              <Fig label="Miss distance" value={`${plan.baseline.miss_km.toFixed(2)} → ${rec.new_miss_km.toFixed(2)} km`} />
              <Fig label="Collision probability" value={`${fmtPc(plan.baseline.pc)} → ${fmtPc(rec.new_pc)}`} />
              {plan.decision_deadline ? (
                <Fig
                  label="Decision deadline"
                  value={fmtUtc(plan.decision_deadline.burn_utc)}
                  sub={`T−${plan.decision_deadline.lead_h.toFixed(2)} h · ${fmtDvUnit(plan.decision_deadline.dv_ms)}${
                    plan.decision_deadline.total_kg != null ? ` · ${fmtMass(plan.decision_deadline.total_kg)}` : ""
                  }`}
                />
              ) : (
                <Fig label="Decision deadline" value={DASH} sub="no option ≤ 1 m/s" />
              )}
              <p className="mt-1 text-[14px] leading-snug text-muted">
                Deadline: latest evaluated burn time (0.5–3 orbits before TCA) where a checked option ≤ 1 m/s still works.
              </p>
              <h5 className="mt-3 font-serif text-[17px] font-semibold">Fuel cost (est.)</h5>
              <FuelBreakdown plan={plan} />
            </div>
          ) : (
            <p className="mt-2 text-[15px]">{plan.note ?? "No recommendation."}</p>
          )}

          {(plan.candidates?.length ?? 0) > 0 && <ParetoChart plan={plan} />}

          {plan.constraint && (
            <p className="mt-2 text-[14px] leading-snug text-muted">
              Re-screened the {plan.constraint.checked} cheapest options against {plan.constraint.pairs_after_altitude_filter.toLocaleString()} objects
              (burn → TCA + 24 h): {plan.constraint.passed} passed, {plan.constraint.checked - plan.constraint.passed} rejected for a new conjunction
              (Pc &gt; 1e−5 or miss &lt; 1 km)
              {plan.constraint.co_located_excluded > 0 && `; ${plan.constraint.co_located_excluded} docked/co-located objects excluded`}.
            </p>
          )}
          <p className="mt-1 text-[14px] text-muted">
            {counts.meeting} of {counts.total} candidates reach Pc &lt; {fmtPc(plan.target_pc ?? params.target)}.
            {plan.timing_s && ` Planned in ${plan.timing_s.total.toFixed(1)} s${plan.cached ? " (cached)" : ""}.`}
          </p>

          {plan.path && (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[15px]">
              <input type="checkbox" checked={showPath} onChange={(e) => onShowPath(e.target.checked)} />
              Show avoidance path on the globe
            </label>
          )}

          <div className="divider my-3" />
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[14px] text-muted">
              Wet mass kg
              <input
                value={massIn}
                onChange={(e) => setMassIn(e.target.value)}
                inputMode="decimal"
                placeholder={String(DEFAULT_MASS)}
                className="field mt-1 px-2"
              />
            </label>
            <label className="text-[14px] text-muted">
              Isp s
              <input value={ispIn} onChange={(e) => setIspIn(e.target.value)} inputMode="decimal" placeholder={String(DEFAULT_ISP)} className="field mt-1 px-2" />
            </label>
            <label className="text-[14px] text-muted">
              Target Pc
              <select value={targetIn} onChange={(e) => setTargetIn(Number(e.target.value))} className="field mt-1 px-1.5">
                {TARGETS.map((t) => (
                  <option key={t} value={t}>
                    {fmtPc(t)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[14px] text-muted">
              Tank kg
              <input
                value={tankIn}
                onChange={(e) => setTankIn(e.target.value)}
                inputMode="decimal"
                placeholder={String(+((params.mass ?? DEFAULT_MASS) * DEFAULT_TANK_FRACTION).toPrecision(4))}
                className="field mt-1 px-2"
              />
            </label>
            <label className="text-[14px] text-muted">
              Station-keeping m/s per yr
              <input value={skIn} onChange={(e) => setSkIn(e.target.value)} inputMode="decimal" placeholder={String(DEFAULT_SK)} className="field mt-1 px-2" />
            </label>
          </div>
          {plan.inputs && (plan.inputs.mass_assumed || plan.inputs.isp_assumed || plan.inputs.tank_assumed || plan.inputs.stationkeeping_assumed) && (
            <p className="mt-1 text-[14px] leading-snug text-muted">
              Assumed until you enter your satellite&apos;s values:
              {plan.inputs.mass_assumed && ` mass ${plan.inputs.mass_kg} kg;`}
              {plan.inputs.isp_assumed && ` Isp ${plan.inputs.isp_s} s (hydrazine);`}
              {plan.inputs.tank_assumed && plan.inputs.tank_kg != null && ` tank ${+plan.inputs.tank_kg.toPrecision(4)} kg (10 % of mass);`}
              {plan.inputs.stationkeeping_assumed && ` station-keeping ${plan.inputs.stationkeeping_ms_per_year} m/s per year.`}
            </p>
          )}
          <button type="button" onClick={rerun} className="quiet-btn mt-2">
            Re-run plan
          </button>
          {inputErr && <p className="mt-1 text-[14px] text-rose">{inputErr}</p>}

          <details className="mt-3">
            <summary className="cursor-pointer text-[14px] text-muted hover:text-gold">Assumptions ({plan.assumptions.length})</summary>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[14px] leading-snug text-ivory">
              {plan.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
