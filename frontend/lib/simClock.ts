"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Simulation clock shared by the globe, Earth rotation (GMST), sun direction and panels.
 * sim = anchorSim + (wall - anchorWall) * speed while playing.
 */
interface ClockState {
  anchorSim: number;
  anchorWall: number;
  speed: number;
  playing: boolean;
}

let state: ClockState = { anchorSim: Date.now(), anchorWall: Date.now(), speed: 1, playing: true };
const listeners = new Set<() => void>();

function emit(next: ClockState) {
  state = next;
  listeners.forEach((l) => l());
}

function reanchor(): Pick<ClockState, "anchorSim" | "anchorWall"> {
  return { anchorSim: simNow(), anchorWall: Date.now() };
}

/** Current simulated time in ms since the Unix epoch (UTC). */
export function simNow(): number {
  return state.playing ? state.anchorSim + (Date.now() - state.anchorWall) * state.speed : state.anchorSim;
}

/** Effective speed multiplier (0 while paused). */
export function simSpeed(): number {
  return state.playing ? state.speed : 0;
}

export const simClock = {
  setSpeed(speed: number) {
    emit({ ...state, ...reanchor(), speed });
  },
  togglePlay() {
    emit({ ...state, ...reanchor(), playing: !state.playing });
  },
  pause() {
    if (state.playing) emit({ ...state, ...reanchor(), playing: false });
  },
  /** Jump to an absolute simulated time (ms). */
  setTime(ms: number) {
    emit({ ...state, anchorSim: ms, anchorWall: Date.now() });
  },
  /** Back to real time at 1x. */
  now() {
    emit({ anchorSim: Date.now(), anchorWall: Date.now(), speed: 1, playing: true });
  },
};

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Speed / play state (re-renders only when controls change). */
export function useClockState(): ClockState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Simulated time as a Date, refreshed every `intervalMs` (null until mounted). */
export function useSimNow(intervalMs = 1000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  const control = useClockState();
  useEffect(() => {
    const tick = () => setNow(new Date(simNow()));
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs, control]);
  return now;
}
