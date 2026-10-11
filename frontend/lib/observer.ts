"use client";

import { useCallback, useEffect, useState } from "react";

/** Where "Above me" and "Visible passes" are computed for. */
export interface Observer {
  lat: number;
  lon: number;
  /** Place name shown in the UI, e.g. "Hubballi" or "My location". */
  label: string;
  /** Secondary line, e.g. "Karnataka, India" or the coordinates. */
  detail?: string;
  /** Metres above sea level; omitted when unknown (the backend then uses its default). */
  alt_m?: number;
}

/** Hubballi (Hubli), Karnataka. Elevation ~627 m (GeoNames via Open-Meteo). */
export const DEFAULT_OBSERVER: Observer = {
  lat: 15.3647,
  lon: 75.124,
  label: "Hubballi",
  detail: "Karnataka, India",
  alt_m: 627,
};

const STORAGE_KEY = "kesslerwatch.observer";

function isObserver(v: unknown): v is Observer {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.lat === "number" &&
    typeof o.lon === "number" &&
    Math.abs(o.lat) <= 90 &&
    Math.abs(o.lon) <= 180 &&
    typeof o.label === "string"
  );
}

function read(): Observer | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isObserver(parsed) ? parsed : null;
  } catch {
    return null; // storage blocked or corrupt: fall back to the default
  }
}

/**
 * The chosen observer, remembered for the browser session (sessionStorage). The first render
 * always uses the default so server and client markup match; the saved choice is applied right after mount.
 */
export function useObserver(): [Observer, (o: Observer) => void] {
  const [observer, setObserverState] = useState<Observer>(DEFAULT_OBSERVER);

  useEffect(() => {
    const saved = read();
    if (!saved) return;
    const t = setTimeout(() => setObserverState(saved), 0);
    return () => clearTimeout(t);
  }, []);

  const setObserver = useCallback((o: Observer) => {
    setObserverState(o);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(o));
    } catch {
      /* private mode / blocked: the choice still applies for this page view */
    }
  }, []);

  return [observer, setObserver];
}
