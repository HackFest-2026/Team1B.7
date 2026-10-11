"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import {
  ApiError,
  computeLaunchFuel,
  fetchLaunchPresets,
  fetchSentinelAlert,
  fetchSentinelAlerts,
  type LaunchFuelRequest,
  type LaunchFuelResponse,
  type LaunchPresets,
  type LaunchSiteRecord,
  type SentinelAlert,
  type SentinelAlertDetail,
} from "@/lib/api";
import { PALETTE } from "@/lib/theme";
import { FuelBreakdown, fmtDvUnit, fmtMass } from "../hud/FuelBreakdown";
import { DASH, Glass } from "../hud/Glass";

type Mode = "launch" | "orbit";

const fmtKms = (v: number | null | undefined, signed = false) =>
  v == null ? DASH : `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(3)}`;
const fmtKg = (v: number | null | undefined) =>
  v == null ? DASH : v >= 1e5 ? `${(v / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} t` : `${Math.round(v).toLocaleString("en-US")} kg`;
const fmtPc = (pc: number | null | undefined) => (pc == null ? DASH : pc < 1e-12 ? "< 1e−12" : pc.toExponential(1).replace("e-", "e−"));

function Hero({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: ReactNode }) {
  return (
    <Glass className="p-5">
      <div className="eyebrow">{label}</div>
      <div className="mt-3 font-mono text-[32px] leading-none text-ivory">
        {value}
        {unit && <span className="ml-1 text-[17px] text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-2 text-[14px] leading-snug text-muted">{sub}</div>}
    </Glass>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-[14px] text-muted">
      {label}
      {hint && <span className="ml-1 text-muted/80">({hint})</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

// --------------------------------------------------------------------------- charts

/**
 * "Compare all sites": every site in the dataset ranked by propellant per kg of payload for the chosen orbit.
 * Equal values share a rank (first order, every site that can reach the inclination gets the same rotation gain);
 * sites that cannot reach it directly are listed last with their lowest direct inclination.
 */
function CompareSites({ r, onPick }: { r: LaunchFuelResponse; onPick: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const ranked = r.sites.filter((s) => s.rank != null);
  const unreachable = r.sites.filter((s) => s.rank == null);
  const vals = r.sites.flatMap((s) => [s.propellant_per_kg_payload, s.due_east.propellant_per_kg_payload]).filter((v): v is number => v != null);
  const max = Math.max(...vals) * 1.05;
  const allTied = ranked.length > 1 && ranked.every((s) => s.rank === 1);
  const rows = all ? r.sites : [...ranked.slice(0, 10), ...unreachable];
  const W = 120;
  return (
    <div>
      <p className="max-w-[78ch] text-[15px] leading-snug text-ivory">
        {allTied ? (
          <>
            All <span className="font-mono">{ranked.length}</span> sites that can fly {r.inputs.inclination_deg}° directly tie at{" "}
            <span className="font-mono">{ranked[0].propellant_per_kg_payload?.toFixed(2)} kg/kg</span>: at first order the rotation gain at a
            fixed inclination is ω·Re·cos i, the same from any latitude that can reach it.
          </>
        ) : (
          <>Ranked by propellant per kg of payload for {r.inputs.altitude_km} km at {r.inputs.inclination_deg}°.</>
        )}{" "}
        {unreachable.length > 0 && (
          <>
            <span className="font-mono">{unreachable.length}</span> site{unreachable.length > 1 ? "s" : ""} cannot reach it directly.
          </>
        )}{" "}
        Latitude shows in the due-east column (i = |latitude|).
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[15px]">
          <thead>
            <tr className="text-[14px] text-muted">
              <th className="py-1.5 pr-2 font-medium">Rank</th>
              <th className="py-1.5 pr-2 font-medium">Site</th>
              <th className="py-1.5 pr-2 text-right font-medium">Latitude</th>
              <th className="whitespace-nowrap py-1.5 pr-2 text-right font-medium">Rotation km/s</th>
              <th className="whitespace-nowrap py-1.5 pr-2 text-right font-medium">Δv km/s</th>
              <th className="py-1.5 pr-2 font-medium">Propellant kg/kg</th>
              <th className="whitespace-nowrap py-1.5 text-right font-medium">Due east kg/kg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const sel = s.key === r.inputs.site;
              const v = s.propellant_per_kg_payload;
              const e = s.due_east.propellant_per_kg_payload;
              return (
                <tr
                  key={s.key}
                  onClick={() => onPick(s.key)}
                  className={`cursor-pointer border-t border-white/8 transition-colors duration-500 hover:bg-white/[0.03] ${sel ? "bg-gold/10" : ""}`}
                  title={s.reason ?? `Use ${s.name} in the calculator`}
                >
                  <td className="py-1.5 pr-2 font-mono text-ivory">{s.rank != null ? `${s.tied ? "=" : ""}${s.rank}` : "—"}</td>
                  <td className="py-1.5 pr-2">
                    <span className="flex items-start gap-2">
                      <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: s.indian ? PALETTE.gold : PALETTE.silver }} />
                      <span className="leading-tight">
                        <span className={`block ${sel ? "text-gold" : "text-ivory"}`}>{s.short_name}</span>
                        <span className="block text-[14px] text-muted">
                          {s.country}
                          {s.status !== "operational" && ` · ${s.status}`}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-right font-mono">
                    {Math.abs(s.lat_deg).toFixed(2)}° {s.lat_deg >= 0 ? "N" : "S"}
                  </td>
                  {s.rank != null ? (
                    <>
                      <td className="py-1.5 pr-2 text-right font-mono">{fmtKms(s.rotation_bonus_kms, true)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{s.total_dv_kms?.toFixed(3)}</td>
                      <td className="py-1.5 pr-2">
                        <span className="flex items-center gap-2">
                          <svg width={W} height="10" aria-hidden>
                            <rect x="0" y="1" width={((v ?? 0) / max) * W} height="8" rx="3" fill={PALETTE.gold} fillOpacity={sel ? 1 : 0.7} />
                            {e != null && <line x1={(e / max) * W} x2={(e / max) * W} y1="0" y2="10" stroke={PALETTE.ice} strokeWidth="2" />}
                          </svg>
                          <span className="font-mono">{v?.toFixed(2)}</span>
                        </span>
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className="py-1.5 pr-2 text-[14px] text-muted">
                      {s.reachable
                        ? "Not feasible with these settings"
                        : `Cannot reach ${r.inputs.inclination_deg}° directly (lowest ${s.min_inclination_deg.toFixed(1)}°)`}
                    </td>
                  )}
                  <td className="py-1.5 text-right font-mono text-ivory">{e != null ? e.toFixed(2) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px] text-muted">
        <span className="flex items-center gap-2">
          <span className="h-2 w-5 rounded-[3px] bg-gold" /> This orbit
        </span>
        <span className="flex items-center gap-2">
          <span className="h-3 w-[2px] bg-ice" /> Due east from the site
        </span>
        <span>Click a row to use that site.</span>
        {ranked.length > 10 && (
          <button type="button" className="quiet-btn" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${r.sites.length} sites`}
          </button>
        )}
      </div>
    </div>
  );
}

/** Propellant per kg of payload vs target altitude (one line, crosshair readout, selected altitude marked). */
function AltitudeChart({ r }: { r: LaunchFuelResponse }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pts = r.altitude_sweep.filter((p) => p.propellant_per_kg_payload != null) as { altitude_km: number; total_dv_kms: number; propellant_per_kg_payload: number }[];
  if (pts.length < 2) return <p className="text-[15px]">{r.result.reason ?? "Not feasible with these settings at any altitude in 300–2000 km."}</p>;
  const W = 640;
  const H = 260;
  const L = 52;
  const R = 16;
  const T = 16;
  const B = 40;
  const x0 = 300;
  const x1 = 2000;
  const ys = pts.map((p) => p.propellant_per_kg_payload);
  const lo = Math.floor(Math.min(...ys) / 10) * 10;
  const hi = Math.ceil(Math.max(...ys) / 10) * 10;
  const sx = (a: number) => L + ((a - x0) / (x1 - x0)) * (W - L - R);
  const sy = (v: number) => T + ((hi - v) / (hi - lo || 1)) * (H - T - B);
  const step = hi - lo > 60 ? 20 : 10;
  const yTicks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) yTicks.push(v);
  const sel = r.inputs.altitude_km;
  const selV = r.result.propellant_per_kg_payload;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const b = svgRef.current?.getBoundingClientRect();
    if (!b) return;
    const x = ((e.clientX - b.left) / b.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(sx(pts[i].altitude_km) - x) < Math.abs(sx(pts[best].altitude_km) - x)) best = i;
    setHover(best);
  };
  const hp = hover != null ? pts[hover] : null;
  return (
    <figure className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none"
        role="img"
        aria-label="Propellant per kilogram of payload for circular orbits from 300 to 2000 km"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="rgb(255 255 255 / 0.06)" />
            <text x={L - 8} y={sy(v) + 5} fill={PALETTE.muted} fontSize="14" textAnchor="end" fontFamily="var(--font-geist-mono)">
              {v}
            </text>
          </g>
        ))}
        {[300, 600, 900, 1200, 1500, 1800, 2000].map((a) => (
          <text key={a} x={sx(a)} y={H - B + 20} fill={PALETTE.muted} fontSize="14" textAnchor="middle" fontFamily="var(--font-geist-mono)">
            {a}
          </text>
        ))}
        <text x={(L + W - R) / 2} y={H - 4} fill={PALETTE.muted} fontSize="14" textAnchor="middle">
          target circular altitude (km)
        </text>
        <polyline
          points={pts.map((p) => `${sx(p.altitude_km).toFixed(1)},${sy(p.propellant_per_kg_payload).toFixed(1)}`).join(" ")}
          fill="none"
          stroke={PALETTE.gold}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {selV != null && sel >= x0 && sel <= x1 && (
          <g pointerEvents="none">
            <circle cx={sx(sel)} cy={sy(selV)} r={5} fill={PALETTE.gold} stroke={PALETTE.space} strokeWidth={2} />
            <text x={sx(sel) + 10} y={sy(selV) - 10} fill={PALETTE.ivory} fontSize="14" fontFamily="var(--font-geist-mono)">
              {sel} km · {selV.toFixed(1)} kg/kg
            </text>
          </g>
        )}
        {hp && (
          <g pointerEvents="none">
            <line x1={sx(hp.altitude_km)} x2={sx(hp.altitude_km)} y1={T} y2={H - B} stroke={PALETTE.ivory} strokeOpacity={0.35} />
            <circle cx={sx(hp.altitude_km)} cy={sy(hp.propellant_per_kg_payload)} r={4} fill={PALETTE.gold} stroke={PALETTE.space} strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-white/10 bg-black/80 px-2.5 py-1.5 text-[14px] leading-snug backdrop-blur"
          style={sx(hp.altitude_km) > W / 2 ? { left: 60 } : { right: 20 }}
        >
          <div className="font-mono text-ivory">{hp.altitude_km} km</div>
          <div className="font-mono text-gold">{hp.propellant_per_kg_payload.toFixed(2)} kg/kg</div>
          <div className="font-mono text-ivory">
            Δv {hp.total_dv_kms.toFixed(3)} <span className="font-sans text-muted">km/s</span>
          </div>
        </div>
      )}
    </figure>
  );
}

// --------------------------------------------------------------------------- launch mode

interface Form {
  site: string;
  lat: string;
  altitude: string;
  inclination: string;
  payload: string;
  propellant: string;
  isp: string;
  stages: string;
  eps: string;
  losses: string;
}

function toRequest(f: Form): LaunchFuelRequest | string {
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const req: LaunchFuelRequest = {
    site: f.site === "custom" ? null : f.site,
    lat_deg: f.site === "custom" ? num(f.lat) : null,
    altitude_km: num(f.altitude),
    inclination_deg: num(f.inclination),
    payload_kg: num(f.payload),
    propellant: f.propellant === "custom" ? null : f.propellant,
    isp_s: f.propellant === "custom" ? num(f.isp) : null,
    stages: num(f.stages),
    structural_fraction: num(f.eps),
    losses_kms: num(f.losses),
  };
  if (req.lat_deg != null && !(req.lat_deg > -90 && req.lat_deg < 90)) return "Latitude must be between −90° and 90°.";
  if (!(req.altitude_km >= 100 && req.altitude_km <= 40000)) return "Altitude must be 100–40,000 km.";
  if (!(req.inclination_deg >= 0 && req.inclination_deg <= 180)) return "Inclination must be 0–180°.";
  if (!(req.payload_kg > 0 && req.payload_kg <= 1e6)) return "Payload must be 0–1,000,000 kg.";
  if (req.isp_s != null && !(req.isp_s >= 50 && req.isp_s <= 1000)) return "Isp must be 50–1,000 s.";
  if (!(req.structural_fraction > 0 && req.structural_fraction < 1)) return "Structural fraction must be between 0 and 1.";
  if (!(req.losses_kms >= 0 && req.losses_kms <= 5)) return "Loss allowance must be 0–5 km/s.";
  return req;
}

function LaunchMode({ siteRequest }: { siteRequest: { id: string; n: number } | null }) {
  const [presets, setPresets] = useState<LaunchPresets | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [res, setRes] = useState<LaunchFuelResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchLaunchPresets()
      .then((p) => {
        if (!alive) return;
        setPresets(p);
        const d = p.defaults;
        // Only the first load creates the form, so a late response never undoes a site chosen meanwhile.
        setForm((f) => f ?? {
          site: d.site,
          lat: "",
          altitude: String(d.altitude_km),
          inclination: String(d.inclination_deg),
          payload: String(d.payload_kg),
          propellant: d.propellant,
          isp: "",
          stages: String(d.stages),
          eps: String(d.structural_fraction),
          losses: String(d.losses_kms),
        });
      })
      .catch((e) => alive && setErr(e instanceof ApiError ? e.message : "Launch presets unavailable."));
    return () => {
      alive = false;
    };
  }, []);

  // Recompute shortly after each edit (the backend answer is instant).
  useEffect(() => {
    if (!form) return;
    const req = toRequest(form);
    let alive = true;
    const t = setTimeout(() => {
      if (typeof req === "string") {
        setErr(req);
        return;
      }
      setBusy(true);
      computeLaunchFuel(req)
        .then((r) => alive && (setRes(r), setErr(null)))
        .catch((e) => alive && setErr(e instanceof ApiError ? e.message : "Could not compute."))
        .finally(() => alive && setBusy(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [form]);

  // "Use in fuel calculator" from a launch-site card (or a ranking row) selects that site.
  const [applied, setApplied] = useState<number | null>(null);
  if (form && siteRequest && siteRequest.n !== applied && presets?.sites[siteRequest.id]) {
    setApplied(siteRequest.n);
    setForm({ ...form, site: siteRequest.id });
  }

  if (!presets || !form) return <p className="text-[17px]">{err ?? "Loading launch presets…"}</p>;
  const groups = Object.entries(presets.sites).reduce<Record<string, [string, LaunchPresets["sites"][string]][]>>((g, e) => {
    (g[e[1].country] ??= []).push(e);
    return g;
  }, {});
  const countryOrder = Object.keys(groups).sort((a, b) => Number(b === "India") - Number(a === "India") || a.localeCompare(b));
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const m = res?.result;
  const b = m?.budget;

  return (
    <div className="space-y-6">
      <Glass className="p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Launch site">
            <select value={form.site} onChange={set("site")} className="field">
              {countryOrder.map((c) => (
                <optgroup key={c} label={c}>
                  {groups[c].map(([k, st]) => (
                    <option key={k} value={k}>
                      {st.short_name} · {Math.abs(st.lat_deg).toFixed(2)}° {st.lat_deg >= 0 ? "N" : "S"}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value="custom">Custom latitude</option>
            </select>
          </Field>
          {form.site === "custom" && (
            <Field label="Latitude" hint="°, N positive">
              <input value={form.lat} onChange={set("lat")} inputMode="decimal" className="field font-mono" placeholder="e.g. 13.72" />
            </Field>
          )}
          <Field label="Target altitude" hint="km, circular">
            <input value={form.altitude} onChange={set("altitude")} inputMode="decimal" className="field font-mono" />
          </Field>
          <Field label="Inclination" hint="°">
            <input value={form.inclination} onChange={set("inclination")} inputMode="decimal" className="field font-mono" />
          </Field>
          <Field label="Payload mass" hint="kg">
            <input value={form.payload} onChange={set("payload")} inputMode="decimal" className="field font-mono" />
          </Field>
          <Field label="Propellant" hint="typical Isp, assumed">
            <select value={form.propellant} onChange={set("propellant")} className="field">
              {Object.entries(presets.propellants).map(([k, p]) => (
                <option key={k} value={k}>
                  {p.name} · {p.isp_s} s
                </option>
              ))}
              <option value="custom">Custom Isp</option>
            </select>
          </Field>
          {form.propellant === "custom" && (
            <Field label="Isp" hint="s">
              <input value={form.isp} onChange={set("isp")} inputMode="decimal" className="field font-mono" placeholder="e.g. 311" />
            </Field>
          )}
          <Field label="Stages">
            <select value={form.stages} onChange={set("stages")} className="field">
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Structural fraction" hint="assumed">
            <input value={form.eps} onChange={set("eps")} inputMode="decimal" className="field font-mono" />
          </Field>
          <Field label="Gravity + drag losses" hint="km/s, assumed">
            <input value={form.losses} onChange={set("losses")} inputMode="decimal" className="field font-mono" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[14px] text-muted">
          <span>Quick orbits:</span>
          {[
            { label: "ISS-like 420 km, 51.6°", alt: "420", inc: "51.6" },
            { label: "Sun-synchronous 500 km, 97.4°", alt: "500", inc: "97.4" },
            { label: "Mid-inclination 500 km, 45°", alt: "500", inc: "45" },
          ].map((q) => (
            <button key={q.label} type="button" className="quiet-btn" onClick={() => setForm({ ...form, altitude: q.alt, inclination: q.inc })}>
              {q.label}
            </button>
          ))}
          {busy && <Loader2 className="h-4 w-4 animate-spin text-muted motion-reduce:animate-none" aria-label="Computing" />}
        </div>
        {err && <p className="mt-2 text-[15px] text-rose">{err}</p>}
      </Glass>

      {res && m && b && (
        <>
          {!m.feasible && <Glass className="p-5 text-[17px]">{m.reason}</Glass>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Hero label="Total Δv (est.)" value={b.total_kms != null ? b.total_kms.toFixed(3) : DASH} unit="km/s" sub="ideal + losses − Earth rotation" />
            <Hero
              label="Propellant per kg of payload"
              value={m.propellant_per_kg_payload != null ? m.propellant_per_kg_payload.toFixed(1) : DASH}
              unit="kg/kg"
              sub={m.propellant_total_kg != null ? `${fmtKg(m.propellant_total_kg)} propellant in total` : undefined}
            />
            <Hero label="Gross lift-off mass" value={m.gross_liftoff_kg != null ? fmtKg(m.gross_liftoff_kg) : DASH} sub={`${res.inputs.stages} stage${res.inputs.stages > 1 ? "s" : ""}, Isp ${res.inputs.isp_s} s`} />
            <Hero label="Payload fraction" value={m.payload_fraction_pct != null ? m.payload_fraction_pct.toFixed(2) : DASH} unit="%" sub="payload ÷ lift-off mass" />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Glass className="p-5">
              <h2 className="heading">Δv budget</h2>
              <table className="mt-3 w-full text-[16px]">
                <tbody>
                  <tr className="border-b border-white/8">
                    <td className="py-2">Ideal, surface to {res.inputs.altitude_km} km circular</td>
                    <td className="py-2 text-right font-mono">{fmtKms(b.ideal_kms)}</td>
                    <td className="py-2 pl-2 text-[14px] text-muted">km/s</td>
                  </tr>
                  <tr className="border-b border-white/8">
                    <td className="py-2">Gravity + drag losses (assumed)</td>
                    <td className="py-2 text-right font-mono">+{b.losses_kms.toFixed(3)}</td>
                    <td className="py-2 pl-2 text-[14px] text-muted">km/s</td>
                  </tr>
                  <tr className="border-b border-white/8">
                    <td className="py-2">
                      Earth rotation {b.rotation_bonus_kms != null && b.rotation_bonus_kms < 0 ? "penalty (retrograde)" : "gain"}
                    </td>
                    <td className={`py-2 text-right font-mono ${b.rotation_bonus_kms != null && b.rotation_bonus_kms < 0 ? "text-rose" : ""}`}>
                      {b.rotation_bonus_kms != null ? fmtKms(-b.rotation_bonus_kms, true) : DASH}
                    </td>
                    <td className="py-2 pl-2 text-[14px] text-muted">km/s</td>
                  </tr>
                  <tr>
                    <td className="py-2 font-semibold">Total (est.)</td>
                    <td className="py-2 text-right font-mono text-gold">{fmtKms(b.total_kms)}</td>
                    <td className="py-2 pl-2 text-[14px] text-muted">km/s</td>
                  </tr>
                </tbody>
              </table>
              <div className="mt-3 space-y-1 text-[14px] leading-snug text-muted">
                <p>
                  Site surface speed <span className="font-mono text-ivory">{b.rotation.v_rot_kms.toFixed(3)} km/s</span> at{" "}
                  <span className="font-mono text-ivory">{res.inputs.lat_deg}°</span>
                  {b.rotation.azimuth_deg != null && (
                    <>
                      ; launch azimuth <span className="font-mono text-ivory">{b.rotation.azimuth_deg.toFixed(1)}°</span> or{" "}
                      <span className="font-mono text-ivory">{b.rotation.azimuth_alt_deg?.toFixed(1)}°</span> from north (sin β = cos i ÷ cos lat)
                    </>
                  )}
                  .
                </p>
                {!b.reachable && <p className="text-rose">{b.rotation.reason}</p>}
                <p>
                  Ideal is energy-equivalent (vis-viva: √(μ(2/Re − 1/r))). A two-burn Hohmann ascent from the surface needs{" "}
                  <span className="font-mono text-ivory">{b.hohmann_reference_kms.toFixed(3)} km/s</span>, inside the loss allowance.
                </p>
              </div>
            </Glass>

            <Glass className="p-5">
              <h2 className="heading">Stages</h2>
              {m.stages ? (
                <table className="mt-3 w-full text-[15px]">
                  <thead>
                    <tr className="text-left text-[14px] text-muted">
                      <th className="py-1.5 font-medium">Stage</th>
                      <th className="py-1.5 text-right font-medium">Δv km/s</th>
                      <th className="py-1.5 text-right font-medium">Mass ratio</th>
                      <th className="py-1.5 text-right font-medium">Propellant</th>
                      <th className="py-1.5 text-right font-medium">Structure</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {m.stages.map((s) => (
                      <tr key={s.stage} className="border-t border-white/8">
                        <td className="py-2 font-sans">{s.stage}</td>
                        <td className="py-2 text-right">{s.dv_kms.toFixed(3)}</td>
                        <td className="py-2 text-right">{s.mass_ratio.toFixed(2)}</td>
                        <td className="py-2 text-right">{fmtKg(s.propellant_kg)}</td>
                        <td className="py-2 text-right">{fmtKg(s.structure_kg)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-white/8">
                      <td className="py-2 font-sans text-muted">Payload</td>
                      <td colSpan={3} />
                      <td className="py-2 text-right">{fmtKg(res.inputs.payload_kg)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p className="mt-3 text-[17px]">{m.reason}</p>
              )}
              <p className="mt-3 text-[14px] leading-snug text-muted">
                Equal Δv per stage. Mass ratio R = e^(Δv ÷ (Isp·g0)); stage mass = mass above × (R − 1) ÷ (1 − R·ε), ε ={" "}
                {res.inputs.structural_fraction} (assumed).
              </p>
            </Glass>
          </div>

          <Glass className="p-5">
            <h2 className="heading">Compare all sites</h2>
            <div className="mt-2">
              <CompareSites r={res} onPick={(key) => setForm({ ...form, site: key })} />
            </div>
          </Glass>

          <Glass className="p-5">
            <h2 className="heading">Propellant per kg vs altitude</h2>
            <p className="mt-1 text-[15px] text-ivory">
              {res.inputs.site_name}, {res.inputs.inclination_deg}°, 300–2000 km circular. Hover for values.
            </p>
            <div className="mt-3">
              <AltitudeChart r={res} />
            </div>
          </Glass>

          <details className="glass p-5">
            <summary className="cursor-pointer text-[15px] text-ivory hover:text-gold">Assumptions ({res.assumptions.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] leading-snug text-ivory">
              {res.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
              <li>
                Constants: μ = {res.constants.mu_km3_s2} km³/s², Re = {res.constants.re_km} km, g0 = {res.constants.g0_ms2} m/s².
              </li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- in-orbit mode

const STEPS: { title: string; body: string }[] = [
  {
    title: "Find the burn",
    body: "For each alert the planner tries 600 impulsive burns (±along-track, ±radial, ±cross-track; 0.005–2 m/s; 0.5–3 orbits before closest approach), propagates each with two-body + J2 on top of SGP4, and re-screens the cheapest against the full catalog so a burn never creates a new conjunction.",
  },
  {
    title: "Price it",
    body: "Propellant from the rocket equation, m·(1 − e^(−Δv ÷ (Isp·g0))). The return-to-orbit burn is estimated at the same Δv. Tank share and days of station-keeping life use stated assumptions you can change in Live → Screening → Avoidance.",
  },
  {
    title: "Time it",
    body: "A linearised state-transition matrix gives the minimum Δv for every burn time up to 6 orbits ahead. Along-track drift grows with time, so an earlier burn needs less Δv, until the decision deadline.",
  },
];

function OrbitMode({ onOpenAlert }: { onOpenAlert: (id: string) => void }) {
  const [alerts, setAlerts] = useState<SentinelAlert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<SentinelAlertDetail | null>(null);

  useEffect(() => {
    fetchSentinelAlerts()
      .then((a) => {
        const planned = a.filter((x) => x.cost_of_acting.available && x.hours_to_tca > 0 && x.status !== "RESOLVED");
        setAlerts(planned);
        if (planned[0]) setSel(planned[0].id);
      })
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Sentinel unavailable."));
  }, []);

  useEffect(() => {
    if (!sel) return;
    let alive = true;
    fetchSentinelAlert(sel)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null));
    return () => {
      alive = false;
    };
  }, [sel]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <Glass key={s.title} className="p-5">
            <div className="font-mono text-[14px] text-gold">0{i + 1}</div>
            <h3 className="mt-1 font-serif text-[20px] font-semibold">{s.title}</h3>
            <p className="mt-1.5 text-[15px] leading-snug text-ivory">{s.body}</p>
          </Glass>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Glass className="p-5">
          <h2 className="heading">Alerts with a plan</h2>
          <p className="mt-1 text-[15px] text-ivory">Sentinel&apos;s live alerts that have a recommended burn. Fuel is avoid + return (est.).</p>
          {err && <p className="mt-2 text-[15px] text-rose">{err}</p>}
          {!alerts && !err && <p className="mt-2 text-[15px] text-muted">Loading…</p>}
          {alerts?.length === 0 && (
            <p className="mt-2 text-[15px]">No live alert has a recommended burn right now. Sentinel plans up to 6 alerts per hourly cycle.</p>
          )}
          <ul className="mt-3 space-y-2">
            {alerts?.slice(0, 12).map((a) => {
              const c = a.cost_of_acting;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setSel(a.id)}
                    aria-pressed={sel === a.id}
                    className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors duration-500 ${
                      sel === a.id ? "border-gold/50 bg-white/[0.06]" : "border-white/8 bg-white/[0.02] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[16px] font-semibold">
                        {a.primary_name} <span className="font-medium text-muted">vs {a.secondary_name}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[14px] text-muted">T−{a.hours_to_tca.toFixed(1)} h</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[15px]">
                      <span>Pc {fmtPc(a.pc)}</span>
                      <span className="text-gold">Δv {fmtDvUnit(c.dv_ms)}</span>
                      <span>{fmtMass(c.total_kg ?? c.propellant_kg)}</span>
                      {c.total_kg == null && <span className="font-sans text-[14px] text-muted">avoid burn only (older plan)</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Glass>

        <Glass className="p-5">
          {detail ? (
            <>
              <div className="text-[14px] text-muted">
                {detail.primary_name} · {detail.tier}
              </div>
              <h2 className="heading">vs {detail.secondary_name}</h2>
              <div className="mt-1 font-mono text-[15px] text-ivory">
                Pc {fmtPc(detail.pc)} · miss {detail.miss_km.toFixed(2)} km
              </div>
              {detail.plan && <FuelBreakdown plan={detail.plan} />}
              <button type="button" className="quiet-btn mt-4 inline-flex items-center gap-1.5" onClick={() => onOpenAlert(detail.id)}>
                Show on the globe <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
              </button>
              {detail.plan?.fuel && (
                <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[14px] leading-snug text-muted">
                  {detail.plan.fuel.assumptions.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-[15px] text-muted">{alerts?.length ? "Loading the plan…" : "Pick an alert to see its fuel cost."}</p>
          )}
        </Glass>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- tab

export function FuelTab({
  onOpenAlert,
  siteRequest = null,
}: {
  onOpenAlert: (id: string) => void;
  /** Launch site chosen elsewhere ("Use in fuel calculator"); n changes on every request. */
  siteRequest?: { id: string; n: number } | null;
  sites?: LaunchSiteRecord[] | null;
}) {
  const [mode, setMode] = useState<Mode>("launch");
  const [seenReq, setSeenReq] = useState<number | null>(null);
  if (siteRequest && siteRequest.n !== seenReq) {
    setSeenReq(siteRequest.n);
    setMode("launch");
  }
  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-[44px] font-semibold leading-tight">Fuel</h1>
        <p className="mt-2 max-w-[70ch] text-[17px] text-ivory">
          What it costs to reach orbit, and what it costs to stay safe once there. Every figure is a first-order estimate; assumptions are
          labelled and editable.
        </p>
        <div role="tablist" aria-label="Fuel mode" className="glass mt-5 inline-flex rounded-full p-1">
          {(
            [
              ["launch", "Launch to orbit"],
              ["orbit", "In-orbit manoeuvre"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              onClick={() => setMode(k)}
              className={`rounded-full px-4 py-1.5 text-[15px] transition-colors duration-500 ${mode === k ? "bg-white/10 text-gold" : "text-ivory hover:text-gold"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      {mode === "launch" ? <LaunchMode siteRequest={siteRequest} /> : <OrbitMode onOpenAlert={onOpenAlert} />}
    </div>
  );
}
