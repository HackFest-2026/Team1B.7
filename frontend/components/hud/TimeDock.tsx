"use client";

import { Orbit, Pause, Play } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { simClock, simNow, useClockState } from "@/lib/simClock";
import { Glass } from "./Glass";

const SPEEDS = [1, 10, 100, 1000] as const;
const MIN_H = -24;
const MAX_H = 72;
const HOUR = 3_600_000;

function fmtOffset(ms: number): string {
  const sign = ms < 0 ? "−" : "+";
  const abs = Math.abs(ms);
  const h = Math.floor(abs / HOUR);
  const m = Math.floor((abs % HOUR) / 60_000);
  return `T${sign}${h}h ${String(m).padStart(2, "0")}m`;
}

/** Sim time + its offset from wall-clock time, refreshed a few times per second. */
function useTicker(): { sim: number; offset: number } | null {
  const [v, setV] = useState<{ sim: number; offset: number } | null>(null);
  const control = useClockState();
  useEffect(() => {
    const tick = () => {
      const sim = simNow();
      setV({ sim, offset: sim - Date.now() });
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 250);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [control]);
  return v;
}

/** Time dock: play/pause, 1x-1000x, "now" and a scrubber from -24 h to +72 h around real time. */
export function TimeDock({
  style,
  overview,
  onOverview,
}: {
  style?: CSSProperties;
  /** true = camera framed out to MEO/GEO; false = LEO-focused default. */
  overview: boolean;
  onOverview: (v: boolean) => void;
}) {
  const clock = useClockState();
  const t = useTicker();
  const offsetH = t ? t.offset / HOUR : 0;

  return (
    <div className="pointer-events-none fixed bottom-6 z-10 flex justify-center max-[859px]:left-4! max-[859px]:right-4! max-[859px]:bottom-4" style={style}>
      <Glass as="footer" className="flex w-full max-w-[760px] items-center gap-3 rounded-full px-4 py-2 max-[859px]:gap-2">
        <button
          type="button"
          onClick={() => simClock.togglePlay()}
          aria-label={clock.playing ? "Pause" : "Play"}
          className="icon-btn h-9 w-9 shrink-0"
        >
          {clock.playing ? <Pause className="h-4 w-4" strokeWidth={1.75} /> : <Play className="h-4 w-4" strokeWidth={1.75} />}
        </button>

        <div className="flex shrink-0 gap-0.5 max-[859px]:hidden" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={clock.speed === s}
              onClick={() => simClock.setSpeed(s)}
              className={`rounded-full px-2 py-0.5 font-mono text-[14px] transition-colors duration-500 ${
                clock.speed === s ? "bg-white/[0.08] text-gold" : "text-ivory hover:text-gold"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>

        <input
          type="range"
          min={MIN_H}
          max={MAX_H}
          step={0.05}
          value={Math.max(MIN_H, Math.min(MAX_H, offsetH))}
          onChange={(e) => simClock.setTime(Date.now() + Number(e.target.value) * HOUR)}
          aria-label="Time offset from now in hours"
          aria-valuetext={t ? fmtOffset(t.offset) : undefined}
          className="min-w-16 flex-1"
        />

        <div className="shrink-0 text-right leading-tight">
          <div className="whitespace-nowrap font-mono text-[15px] text-ivory">
            {t ? new Date(t.sim).toISOString().slice(0, 19).replace("T", " ") : "—"}
            <span className="ml-1 text-[14px] text-muted">UTC</span>
          </div>
          <div className="font-mono text-[14px] text-muted">{t ? fmtOffset(t.offset) : ""}</div>
        </div>

        <button type="button" onClick={() => simClock.now()} className="quiet-btn shrink-0">
          Now
        </button>
        <button
          type="button"
          onClick={() => onOverview(!overview)}
          aria-pressed={overview}
          title={overview ? "Back to the LEO view" : "Zoom out to the MEO and GEO rings"}
          className={`quiet-btn inline-flex shrink-0 items-center gap-1.5 ${overview ? "border-gold/60! text-gold" : ""}`}
        >
          <Orbit className="h-3.5 w-3.5" strokeWidth={1.75} />
          Overview
        </button>
      </Glass>
    </div>
  );
}
