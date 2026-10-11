"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  fetchAbout,
  fetchDecisionRules,
  fetchSentinelStatus,
  fetchStatus,
  fmtDuration,
  fmtSci,
  type AboutConfig,
  type CatalogStatus,
  type DecisionRules,
  type SentinelStatus,
} from "@/lib/api";
import { DASH, fmtLatLon, Glass } from "../hud/Glass";

const REPO_URL = "https://github.com/ayeshasiddiqav/kesslerwatch";
const TEAM = ["Ayesha Siddiqa V", "Atharv Adake", "Sameer Kulkarni", "Mithesh Mahale", "Rohan Chivate"];

const sci = fmtSci;
const dur = (s: number | undefined) => (s === undefined ? DASH : fmtDuration(s));

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="label-caps mb-3">{label}</h2>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <Glass className="overflow-x-auto p-6">
      <table className="w-full min-w-[560px] text-left text-[15px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="pb-1.5 pr-4 text-[14px] font-medium text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="divider">
              {r.map((c, j) => (
                <td key={j} className={`py-2 pr-4 align-top ${j === 0 ? "whitespace-nowrap font-semibold text-ivory" : "text-ivory"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Glass>
  );
}

function Tag({ kind }: { kind: "assumed" | "est." | "limit" }) {
  return <span className="whitespace-nowrap font-mono text-[14px] text-muted">{kind}</span>;
}

export function AboutTab({ total }: { total: number }) {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [sentinel, setSentinel] = useState<SentinelStatus | null>(null);
  const [rules, setRules] = useState<DecisionRules | null>(null);
  const [cfgAbout, setAbout] = useState<AboutConfig | null>(null);

  useEffect(() => {
    // Each block falls back to a dash if its endpoint is unavailable.
    fetchStatus().then(setStatus).catch(() => undefined);
    fetchSentinelStatus().then(setSentinel).catch(() => undefined);
    fetchDecisionRules().then(setRules).catch(() => undefined);
    fetchAbout().then(setAbout).catch(() => undefined);
  }, []);

  const objects = total > 0 ? total.toLocaleString("en-US") : status ? status.objects.toLocaleString("en-US") : DASH;
  const horizon = sentinel?.horizon_h ?? null;
  const cfg = rules?.config ?? {};
  const obs = status?.default_observer;
  const hours = sentinel?.refresh_s ? sentinel.refresh_s / 3600 : null;
  const cadence = hours === null ? DASH : hours === 1 ? "hour" : `${hours} h`;
  const a = cfgAbout;
  const rs = a?.refresh_s;
  const orbits = a?.avoidance.orbits_before ?? [];

  const pipeline: [string, string][] = [
    ["Data", status?.catalog.source === "space-track" ? "Space-Track GP" : status ? "CelesTrak (fallback)" : DASH],
    ["SGP4", `${objects} objects`],
    ["Screening", a ? `${a.screening.coarse_step_s} s coarse · ${a.screening.refine_step_s} s refine` : DASH],
    ["Risk", "Pc + AI risk"],
    ["Go / No-Go", `GO at ≥ ${sci(cfg.go_pc)}`],
    ["Avoidance", "Δv + fuel"],
    ["Sentinel alerts", hours === null ? DASH : hours === 1 ? "hourly" : `every ${hours} h`],
  ];

  return (
    <div className="space-y-10">
      <header>
        <h1 className="font-serif text-[44px] font-semibold leading-tight">About</h1>
        <p className="mt-2 max-w-[70ch] text-[17px] text-ivory">
          KesslerWatch tracks all {objects} on-orbit objects in the public catalog, screens protected satellites against them for close
          approaches{horizon ? ` over the next ${horizon} h` : ""}, estimates the collision probability (Pc) and an AI probability that the
          risk ends high, recommends Go / No-Go, and sizes the avoidance burn (Δv) and its fuel. Every output is a recommendation; the
          operator decides.
        </p>
      </header>

      <Section label="Pipeline">
        <Glass className="p-6">
          <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {pipeline.map(([name, spec], i) => (
              <li key={name} className="rounded-lg border border-white/10 px-3 py-2">
                <div className="font-mono text-[14px] text-muted">
                  {String(i + 1).padStart(2, "0")}
                  {i < pipeline.length - 1 && <span aria-hidden> →</span>}
                </div>
                <div className="mt-0.5 text-[15px] font-semibold text-ivory">{name}</div>
                <div className="font-mono text-[14px] leading-snug text-muted">{spec}</div>
              </li>
            ))}
          </ol>
        </Glass>
      </Section>

      <Section label="Features">
        <Table
          head={["Feature", "What it does"]}
          rows={[
            [
              "Sentinel",
              `Every ${cadence}, screens ${sentinel?.objects_watched ?? DASH} watchlist objects against the full catalog ${horizon ?? DASH} h ahead; alerts carry the plan and fuel.`,
            ],
            [
              "Avoidance planner",
              a
                ? `Impulsive ±T/±R/±N burns of ${a.avoidance.dv_min_ms}–${a.avoidance.dv_max_ms} m/s, ${orbits[0]}–${orbits[orbits.length - 1]} orbits before TCA; smallest Δv reaching Pc ≤ ${sci(cfg.avoid_target_pc)} without new conjunctions.`
                : DASH,
            ],
            [
              "Go / No-Go",
              `GO: Pc or AI final risk ≥ ${sci(cfg.go_pc)} and a valid burn. WATCH: Pc ≥ ${sci(cfg.watch_pc)}, or AI flag and Pc ≥ ${sci(cfg.watch_ai_min_pc)}.`,
            ],
            [
              "Re-entry watch",
              `Perigee < ${a?.reentry.max_perigee_km ?? DASH} km; decay time from the mean-motion derivative, scaled by the NOAA F10.7 outlook (est.).`,
            ],
            [
              "Above me",
              `Objects overhead and visible passes, SGP4 from our catalog; default ${obs ? `${obs.name}, ${fmtLatLon(obs.lat, obs.lon, 4)}` : DASH}.`,
            ],
          ]}
        />
      </Section>

      <Section label="Data sources">
        <Table
          head={["Source", "What we use", "Refresh"]}
          rows={[
            ["Space-Track GP", "Element sets for every on-orbit object; official type; RCS size", rs?.spacetrack_gp === 3600 ? "≤ 1 per hour" : `≤ 1 per ${dur(rs?.spacetrack_gp)}`],
            ["Space-Track SATCAT", "Indian payloads for the Sentinel watchlist", dur(rs?.spacetrack_satcat)],
            ["CelesTrak GP", "Fallback catalog; active list for Indian payloads", dur(rs?.celestrak)],
            ["NOAA SWPC", "F10.7, Kp, Ap; 27-day F10.7 outlook", `${dur(rs?.swpc)}; outlook ${dur(rs?.swpc_outlook)}`],
            ["ESA Kelvins", "Conjunction Data Messages (AI training and test)", "static"],
            ["Open-Meteo", "City search for the observer (GeoNames data)", "on search"],
            ["N2YO", "Optional cross-check of passes and objects overhead", `${dur(rs?.n2yo_above)} / ${dur(rs?.n2yo_passes)}`],
          ]}
        />
      </Section>

      <Section label="Assumptions & limits">
        <Table
          head={["Item", "Rule", ""]}
          rows={[
            [
              "Position σ",
              a ? `${a.sigma.base_km} km + ${a.sigma.per_day_km} km per day of element-set age; two objects combine as √(σ₁² + σ₂²)` : DASH,
              <Tag key="t" kind="assumed" />,
            ],
            ["Pc", `2-D isotropic Gaussian; hard-body radius ${a?.screening.hbr_m_default ?? DASH} m by default`, <Tag key="t" kind="assumed" />],
            [
              "Fuel",
              a ? `${a.avoidance.mass_kg} kg wet mass, Isp ${a.avoidance.isp_s} s unless given; return burn not modelled` : DASH,
              <Tag key="t" kind="assumed" />,
            ],
            ["Re-entry date", `Heuristic; density sensitivity to F10.7 as exponent ${a?.reentry.f107_exponent ?? DASH}`, <Tag key="t" kind="est." />],
            [
              "Visible pass",
              a ? `Sunlit, ≥ ${a.visibility.min_elevation_deg}° up, sun ≤ ${String(a.visibility.sun_max_elevation_deg).replace("-", "−")}° at the observer` : DASH,
              <Tag key="t" kind="assumed" />,
            ],
            ["AI risk (live)", "Trained on ESA full-covariance Pc; live Pc uses the assumed σ", <Tag key="t" kind="est." />],
            ["Object type", "Inferred from names when the CelesTrak fallback is used", <Tag key="t" kind="limit" />],
            ["Element sets", "TLEs carry no covariance; accuracy degrades with age", <Tag key="t" kind="limit" />],
          ]}
        />
      </Section>

      <Section label="Team">
        <p className="text-[17px] text-ivory">
          <span className="font-semibold">The Invariants</span> · {TEAM.join(" · ")}
        </p>
      </Section>

      <Section label="Source code">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="font-mono text-[17px] text-gold underline-offset-4 hover:underline">
          github.com/ayeshasiddiqav/kesslerwatch
        </a>
      </Section>
    </div>
  );
}
