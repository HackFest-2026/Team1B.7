"use client";

import { useRef, useState, type PointerEvent } from "react";
import type { AvoidFuel, AvoidResponse, FuelOption, LeadCurve } from "@/lib/api";
import { PALETTE } from "@/lib/theme";
import { DASH } from "./Glass";

// Every figure here comes from the backend's rocket-equation results (maneuver_opt.with_fuel); nothing is computed
// in the browser except formatting.

/** Δv with a unit that keeps 3 significant figures readable: mm/s below 0.1 m/s. */
export const fmtDvUnit = (ms: number | null | undefined) =>
  ms == null ? DASH : ms < 0.1 ? `${(ms * 1000).toPrecision(3)} mm/s` : `${ms.toPrecision(3)} m/s`;
/** Propellant in g below 1 kg. */
export const fmtMass = (kg: number | null | undefined) =>
  kg == null ? DASH : kg < 1 ? `${(kg * 1000).toPrecision(3)} g` : `${kg.toPrecision(3)} kg`;
const fmtPc = (pc: number | null | undefined) => (pc == null ? DASH : pc < 1e-12 ? "< 1e−12" : pc.toExponential(1).replace("e-", "e−"));
const fmtSciShort = (v: number | null | undefined) => (v == null ? DASH : v.toExponential(1).replace("e-", "e−").replace("e+", "e"));
const fmtPct = (p: number) => (p < 0.01 ? "< 0.01 %" : `${p.toPrecision(p < 1 ? 2 : 3)} %`);
const fmtDays = (d: number) => (d < 1 ? `${(d * 24).toPrecision(2)} h` : `${d.toPrecision(3)} d`);

/** Avoid / return / total for the recommended burn, plus tank share and station-keeping life cost. */
export function RecommendedFuel({ plan }: { plan: Pick<AvoidResponse, "fuel" | "inputs"> }) {
  const f = plan.fuel?.recommended;
  const inp = plan.inputs;
  if (!f) return null;
  const cols: { label: string; dv: number; kg: number; est?: boolean }[] = [
    { label: "Avoid", dv: f.avoid_dv_ms, kg: f.avoid_kg },
    { label: "Return", dv: f.return_dv_ms, kg: f.return_kg, est: true },
    { label: "Total", dv: f.total_dv_ms, kg: f.total_kg },
  ];
  return (
    <div className="mt-2">
      <div className="grid grid-cols-3 gap-2 rounded-xl bg-white/[0.03] px-2.5 py-2">
        {cols.map((c) => (
          <div key={c.label}>
            <div className="text-[14px] text-muted">
              {c.label}
              {c.est && " (est.)"}
            </div>
            <div className={`font-mono text-[15px] leading-tight ${c.label === "Total" ? "text-gold" : "text-ivory"}`}>{fmtDvUnit(c.dv)}</div>
            <div className={`font-mono text-[15px] leading-tight ${c.label === "Total" ? "text-gold" : "text-ivory"}`}>{fmtMass(c.kg)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {f.tank_pct != null && (
          <div>
            <div className="font-mono text-[20px] leading-none text-ivory">{fmtPct(f.tank_pct)}</div>
            <div className="mt-1 text-[14px] leading-tight text-muted">
              of tank ({inp?.tank_kg != null ? `${inp.tank_kg.toPrecision(3)} kg` : DASH}
              {inp?.tank_assumed ? ", assumed" : ""})
            </div>
          </div>
        )}
        {f.life_days != null && (
          <div>
            <div className="font-mono text-[20px] leading-none text-ivory">≈ {fmtDays(f.life_days)}</div>
            <div className="mt-1 text-[14px] leading-tight text-muted">
              of satellite life (est., {inp?.stationkeeping_ms_per_year ?? DASH} m/s per year
              {inp?.stationkeeping_assumed ? " assumed" : ""})
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Top valid options (target met, constraint passed): cost vs risk removed. Recommended row highlighted. */
export function EfficiencyTable({ fuel }: { fuel: AvoidFuel }) {
  const opts: FuelOption[] = fuel.options;
  if (opts.length === 0) return null;
  const mm = opts.every((o) => o.dv_ms < 0.1);
  const grams = opts.every((o) => o.total_kg < 1);
  const before = opts[0].pc_before;
  return (
    <figure className="mt-3">
      <figcaption className="mb-1 text-[14px] text-muted">
        Top {opts.length} valid option{opts.length === 1 ? "" : "s"} (re-screened, target met)
      </figcaption>
      <table className="w-full border-collapse text-left font-mono text-[14px]">
        <caption className="sr-only">
          Burn direction, burn time before closest approach, delta-v, total propellant, collision probability after the burn, and risk
          removed per gram
        </caption>
        <thead>
          <tr className="font-sans text-muted">
            <th className="py-1 pr-1 font-medium">Dir</th>
            <th className="py-1 pr-1 text-right font-medium">T− h</th>
            <th className="py-1 pr-1 text-right font-medium">Δv {mm ? "mm/s" : "m/s"}</th>
            <th className="py-1 pr-1 text-right font-medium" title="Avoid + return (est.)">
              Fuel {grams ? "g" : "kg"}
            </th>
            <th className="py-1 pr-1 text-right font-medium" title={`Collision probability before the burn: ${fmtPc(before)}`}>
              Pc after
            </th>
            <th className="py-1 text-right font-medium" title="Collision probability removed per gram of total propellant">
              ΔPc/g
            </th>
          </tr>
        </thead>
        <tbody>
          {opts.map((o) => (
            <tr
              key={o.id}
              aria-current={o.recommended ? "true" : undefined}
              className={`border-t border-white/8 ${o.recommended ? "bg-gold/10 text-gold" : "text-ivory"}`}
              title={`${o.direction_label}, burn ${o.burn_utc.slice(5, 16).replace("T", " ")} UTC, new miss ${o.new_miss_km.toFixed(2)} km`}
            >
              <td className="py-1 pr-1">{o.direction}</td>
              <td className="py-1 pr-1 text-right">{o.lead_h.toFixed(2)}</td>
              <td className="py-1 pr-1 text-right">{(mm ? o.dv_ms * 1000 : o.dv_ms).toPrecision(3)}</td>
              <td className="py-1 pr-1 text-right">{(grams ? o.total_kg * 1000 : o.total_kg).toPrecision(3)}</td>
              <td className="py-1 pr-1 text-right">{fmtSciShort(o.pc_after)}</td>
              <td className="py-1 text-right">{fmtSciShort(o.risk_reduction_per_g)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[14px] leading-snug text-muted">
        Pc before: <span className="font-mono text-ivory">{fmtPc(before)}</span>. Fuel = avoid + return (est.). Highlighted: recommended.
      </p>
    </figure>
  );
}

/**
 * Minimum Δv to reach the target vs burn lead time: the linearised curve (est.) plus the planner's non-linear grid
 * results as dots. Earliest burn on the left, TCA on the right; decision deadline and recommended burn marked.
 * One axis (Δv, log); grams appear in the hover readout and the direct labels.
 */
export function LeadTimeChart({
  curve,
  deadlineLeadH,
  recommended,
}: {
  curve: LeadCurve;
  deadlineLeadH: number | null;
  recommended: { lead_h: number; dv_ms: number; total_kg?: number } | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pts = curve.points.filter((p) => p.dv_ms > 0);
  if (pts.length < 2) return curve.note ? <p className="mt-2 text-[14px] text-muted">{curve.note}</p> : null;

  const W = 300;
  const H = 200;
  const L = 44;
  const R = 10;
  const T = 14;
  const B = 34;
  const grid = curve.grid_points.filter((g) => g.dv_ms != null) as { lead_h: number; dv_ms: number; constraint?: string; avoid_kg?: number | null }[];
  const xMax = Math.max(...pts.map((p) => p.lead_h));
  const allDv = [...pts.map((p) => p.dv_ms), ...grid.map((g) => g.dv_ms)];
  const lo = Math.floor(Math.log10(Math.min(...allDv)) * 2) / 2;
  const hi = Math.ceil(Math.log10(Math.max(...allDv)) * 2) / 2;
  const sx = (leadH: number) => L + ((xMax - leadH) / xMax) * (W - L - R); // earliest left, TCA right
  const sy = (dv: number) => T + ((hi - Math.log10(dv)) / (hi - lo || 1)) * (H - T - B);
  const line = pts.map((p) => `${sx(p.lead_h).toFixed(1)},${sy(p.dv_ms).toFixed(1)}`).join(" ");
  const yTicks: number[] = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++)
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (Math.log10(v) >= lo - 1e-9 && Math.log10(v) <= hi + 1e-9) yTicks.push(v);
    }
  const xStep = xMax > 12 ? 4 : xMax > 6 ? 2 : 1;
  const xTicks: number[] = [];
  for (let h = 0; h <= xMax + 1e-9; h += xStep) xTicks.push(h);
  const axisMm = Math.max(...allDv) < 0.1; // one unit for the whole axis
  const tickDv = (v: number) => (axisMm ? `${+(v * 1000).toPrecision(2)}` : `${+v.toPrecision(2)}`);
  const unitNote = axisMm ? "mm/s" : "m/s";

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(sx(pts[i].lead_h) - x) < Math.abs(sx(pts[best].lead_h) - x)) best = i;
    setHover(best);
  };
  const hp = hover != null ? pts[hover] : null;

  return (
    <figure className="mt-3">
      <figcaption className="text-[14px] text-muted">Minimum Δv vs burn time: earlier is cheaper</figcaption>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="mt-1 h-auto w-full touch-none"
          role="img"
          aria-label={`Minimum delta-v to reach the target collision probability, for burns from ${xMax.toFixed(1)} hours to ${pts[0].lead_h.toFixed(1)} hours before closest approach`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="rgb(255 255 255 / 0.06)" />
              <text x={L - 5} y={sy(v) + 4} fill={PALETTE.muted} fontSize="13" textAnchor="end" fontFamily="var(--font-geist-mono)">
                {tickDv(v)}
              </text>
            </g>
          ))}
          {xTicks.map((h) => (
            <text key={h} x={sx(h)} y={H - B + 16} fill={PALETTE.muted} fontSize="13" textAnchor="middle" fontFamily="var(--font-geist-mono)">
              {h === 0 ? "TCA" : `−${h}`}
            </text>
          ))}
          <text x={(L + W - R) / 2} y={H - 3} fill={PALETTE.muted} fontSize="13" textAnchor="middle">
            hours before closest approach
          </text>
          {deadlineLeadH != null && deadlineLeadH <= xMax && (
            <g>
              <line x1={sx(deadlineLeadH)} x2={sx(deadlineLeadH)} y1={T - 4} y2={H - B} stroke={PALETTE.rose} strokeOpacity={0.8} strokeDasharray="3 3" />
              <text x={sx(deadlineLeadH) - 4} y={T + 6} fill={PALETTE.ivory} fontSize="13" textAnchor="end">
                deadline
              </text>
            </g>
          )}
          <polyline points={line} fill="none" stroke={PALETTE.gold} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {grid.map((g) => (
            <circle
              key={g.lead_h}
              cx={sx(g.lead_h)}
              cy={sy(g.dv_ms)}
              r={4}
              fill={g.constraint === "rejected" ? "none" : PALETTE.ivory}
              stroke={g.constraint === "rejected" ? PALETTE.rose : PALETTE.space}
              strokeWidth={g.constraint === "rejected" ? 1.4 : 2}
            >
              <title>{`Grid (non-linear) at T−${g.lead_h.toFixed(2)} h: ${fmtDvUnit(g.dv_ms)}, ${fmtMass(g.avoid_kg)} avoid burn${g.constraint === "rejected" ? ", rejected (new conjunction)" : ""}`}</title>
            </circle>
          ))}
          {recommended && recommended.lead_h <= xMax + 1e-6 && (
            <g pointerEvents="none">
              <circle cx={sx(recommended.lead_h)} cy={sy(recommended.dv_ms)} r={8} fill="none" stroke={PALETTE.gold} strokeWidth={1.4} />
              <text
                x={sx(recommended.lead_h) + (sx(recommended.lead_h) > W / 2 ? -11 : 11)}
                y={sy(recommended.dv_ms) - 10}
                fill={PALETTE.ivory}
                fontSize="13"
                textAnchor={sx(recommended.lead_h) > W / 2 ? "end" : "start"}
                fontFamily="var(--font-geist-mono)"
              >
                {fmtMass(recommended.total_kg)} total
              </text>
            </g>
          )}
          {hp && (
            <g pointerEvents="none">
              <line x1={sx(hp.lead_h)} x2={sx(hp.lead_h)} y1={T} y2={H - B} stroke={PALETTE.ivory} strokeOpacity={0.35} />
              <circle cx={sx(hp.lead_h)} cy={sy(hp.dv_ms)} r={4} fill={PALETTE.gold} stroke={PALETTE.space} strokeWidth={2} />
            </g>
          )}
        </svg>
        {hp && (
          <div
            className="pointer-events-none absolute top-1 rounded-lg border border-white/10 bg-black/80 px-2 py-1 text-[14px] leading-snug backdrop-blur"
            style={sx(hp.lead_h) > W / 2 ? { left: 8 } : { right: 8 }}
          >
            <div className="font-mono text-ivory">T−{hp.lead_h.toFixed(2)} h</div>
            <div className="font-mono text-gold">
              {fmtDvUnit(hp.dv_ms)} {hp.direction}
            </div>
            <div className="font-mono text-ivory">
              {fmtMass(hp.avoid_kg)} <span className="font-sans text-muted">avoid</span>
            </div>
            <div className="font-mono text-ivory">
              {fmtMass(hp.total_kg)} <span className="font-sans text-muted">with return (est.)</span>
            </div>
          </div>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[14px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-[2px] w-4 bg-gold" /> Linearised (est.)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-ivory" /> Full grid
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border border-gold" /> Recommended
        </span>
        <span>Δv in {unitNote}, log scale.</span>
      </div>
    </figure>
  );
}

/** The full in-orbit fuel picture for one plan (used by Avoidance, the Sentinel alert detail and the Fuel tab). */
export function FuelBreakdown({ plan }: { plan: Partial<AvoidResponse> }) {
  if (!plan.fuel) {
    return plan.recommended ? (
      <p className="mt-2 text-[14px] leading-snug text-muted">Return burn, tank share and lead-time cost appear after the next re-plan of this alert.</p>
    ) : null;
  }
  return (
    <div>
      <RecommendedFuel plan={plan as AvoidResponse} />
      <EfficiencyTable fuel={plan.fuel} />
      {plan.lead_curve && (
        <LeadTimeChart
          curve={plan.lead_curve}
          deadlineLeadH={plan.decision_deadline?.lead_h ?? null}
          recommended={plan.recommended ? { lead_h: plan.recommended.lead_h, dv_ms: plan.recommended.dv_ms, total_kg: plan.recommended.total_kg } : null}
        />
      )}
    </div>
  );
}
