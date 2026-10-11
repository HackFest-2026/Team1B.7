"use client";

import { ZoomIn, ZoomOut } from "lucide-react";
import type { CSSProperties } from "react";
import { niceCeil } from "@/lib/encounter";
import { PATH_COLORS, PALETTE } from "@/lib/theme";

const W = 300;
const H = 176;
const CX = W / 2;
const CY = 92;
const HALF = 66; // px from the centre to the farthest drawn feature

/** km label: 2 decimals below 10 km. */
const km = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} km`;

/**
 * "Close-up at TCA": the other object fixed at the centre, its σ circle, and the current (red, dashed) and optimal
 * (green) paths passing at their real miss distances from /avoid, drawn to one km scale. Side view along the relative
 * motion; the out-of-plane direction is folded in (green is drawn on red's side when b0 · b1 ≥ 0, else opposite).
 * Also holds the globe-path key and the "Zoom to encounter" / "Exaggerate separation" controls.
 */
export function EncounterInset({
  miss0,
  miss1,
  sigmaKm,
  sameSide,
  factor,
  zoomed,
  onZoom,
  exaggerated,
  onExaggerate,
  className = "",
  style,
}: {
  miss0: number | null;
  miss1: number | null;
  sigmaKm: number | null;
  sameSide: boolean;
  factor: number;
  zoomed: boolean;
  onZoom: (on: boolean) => void;
  exaggerated: boolean;
  onExaggerate: (on: boolean) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const span = Math.max(miss0 ?? 0, miss1 ?? 0, sigmaKm ?? 0, 0.1);
  const s = HALF / (span * 1.08); // px per km
  const yRed = miss0 != null ? CY - miss0 * s : null;
  const yGreen = miss1 != null ? (sameSide ? CY - miss1 * s : CY + miss1 * s) : null;
  // Scale bar: a 1/2/5 × 10^k km length close to a quarter of the width.
  const barKm = niceCeil((W / 4 / s) * 0.7);
  const barPx = barKm * s;

  return (
    <div className={`glass fixed z-10 w-[332px] rounded-2xl px-4 pb-3 pt-3 ${className}`} style={style} aria-label="Close-up of the encounter at TCA">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="heading">Close-up at TCA</h2>
        <span className="text-[14px] text-muted">true scale</span>
      </div>

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="mt-1 block" role="img"
        aria-label={`Other object at the centre. Current path passes at ${miss0 != null ? km(miss0) : "unknown"}, optimal path at ${miss1 != null ? km(miss1) : "unknown"}.`}>
        <defs>
          <marker id="enc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill={PALETTE.muted} />
          </marker>
        </defs>
        {/* Uncertainty: combined 1σ around the other object (assumed from TLE age, est.). */}
        {sigmaKm != null && (
          <circle cx={CX} cy={CY} r={sigmaKm * s} fill={PALETTE.ivory} fillOpacity={0.05} stroke={PALETTE.muted} strokeOpacity={0.55} strokeDasharray="2 3" />
        )}
        {/* Green first, dashed red on top: they can be < 1 km apart. */}
        {yGreen != null && (
          <>
            <line x1={8} y1={yGreen} x2={W - 8} y2={yGreen} stroke={PATH_COLORS.optimal} strokeWidth={2.4} strokeLinecap="round" />
            <line x1={CX} y1={CY} x2={CX} y2={yGreen} stroke={PATH_COLORS.optimal} strokeOpacity={0.6} strokeWidth={1} />
            <circle cx={CX} cy={yGreen} r={3.2} fill={PATH_COLORS.optimal} />
          </>
        )}
        {yRed != null && (
          <>
            <line x1={8} y1={yRed} x2={W - 8} y2={yRed} stroke={PATH_COLORS.risk} strokeWidth={2.4} strokeDasharray="7 4" strokeLinecap="round" />
            <line x1={CX} y1={CY} x2={CX} y2={yRed} stroke={PATH_COLORS.risk} strokeOpacity={0.6} strokeWidth={1} />
            <circle cx={CX} cy={yRed} r={3.2} fill={PATH_COLORS.risk} />
          </>
        )}
        <circle cx={CX} cy={CY} r={4} fill={PATH_COLORS.other} stroke={PALETTE.space} strokeWidth={1.5} />
        {/* Miss-distance labels beside the closest-approach points; green's goes below when it shares red's side
            and passes closer in, so the two never collide. */}
        {yRed != null && miss0 != null && (
          <text x={CX + 8} y={yRed - 6} className="font-mono" fontSize={14} fill={PALETTE.ivory}>
            {km(miss0)}
          </text>
        )}
        {yGreen != null && miss1 != null && (
          <text x={CX + 8} y={yGreen + (yRed != null && yGreen < yRed ? -6 : 16)} className="font-mono" fontSize={14} fill={PALETTE.ivory}>
            {km(miss1)}
          </text>
        )}
        {/* Direction of relative motion */}
        <line x1={W - 64} y1={H - 14} x2={W - 12} y2={H - 14} stroke={PALETTE.muted} strokeWidth={1.2} markerEnd="url(#enc-arrow)" />
        {/* Scale bar */}
        <line x1={10} y1={H - 14} x2={10 + barPx} y2={H - 14} stroke={PALETTE.ivory} strokeWidth={1.5} />
        <line x1={10} y1={H - 18} x2={10} y2={H - 10} stroke={PALETTE.ivory} strokeWidth={1.5} />
        <line x1={10 + barPx} y1={H - 18} x2={10 + barPx} y2={H - 10} stroke={PALETTE.ivory} strokeWidth={1.5} />
        <text x={16 + barPx} y={H - 9} className="font-mono" fontSize={14} fill={PALETTE.muted}>
          {barKm >= 1 ? `${barKm} km` : `${barKm * 1000} m`}
        </text>
      </svg>

      <div className="mt-1 space-y-px text-[14px] text-ivory">
        <KeyRow color={PATH_COLORS.risk} dashed label={`Current path${miss0 != null ? `, miss ${km(miss0)}` : ""}`} />
        <KeyRow color={PATH_COLORS.optimal} label={miss1 != null ? `Optimal path, new miss ${km(miss1)}` : "No valid option"} />
        <KeyRow color={PATH_COLORS.other} label="Other object (centre)" />
        {sigmaKm != null && <KeyRow color={PALETTE.muted} dotted label={`σ ${km(sigmaKm)} (assumed, est.)`} />}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" className="quiet-btn inline-flex items-center gap-1.5" onClick={() => onZoom(!zoomed)} aria-pressed={zoomed}>
          {zoomed ? <ZoomOut size={15} aria-hidden /> : <ZoomIn size={15} aria-hidden />}
          {zoomed ? "Back to globe" : "Zoom to encounter"}
        </button>
        {factor > 1 && (
          <label className={`flex cursor-pointer items-center gap-2 text-[14px] ${zoomed ? "opacity-50" : ""}`} title={zoomed ? "The close-up is always true scale" : undefined}>
            <input type="checkbox" checked={exaggerated} disabled={zoomed} onChange={(e) => onExaggerate(e.target.checked)} />
            Exaggerate separation ×{factor.toLocaleString("en-US")}
          </label>
        )}
      </div>
      {exaggerated && (
        <p className="mt-2 rounded-lg border border-gold/30 px-2 py-1 text-[14px] text-gold">
          Separation exaggerated ×{factor.toLocaleString("en-US")} for visibility, drawn across the track. Numbers are unchanged.
        </p>
      )}
    </div>
  );
}

function KeyRow({ color, label, dashed, dotted }: { color: string; label: string; dashed?: boolean; dotted?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <svg width="22" height="6" aria-hidden className="shrink-0">
        <line x1="1" y1="3" x2="21" y2="3" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? "5 3" : dotted ? "2 3" : undefined} strokeLinecap="round" />
      </svg>
      {label}
    </div>
  );
}
