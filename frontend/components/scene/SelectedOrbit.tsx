"use client";

import { Line } from "@react-three/drei";
import { useMemo } from "react";
import type { CatalogEntry } from "@/lib/api";
import { orbitPath, toSatrec } from "@/lib/orbit";
import { PALETTE } from "@/lib/theme";

/**
 * One revolution of an object's orbit (SGP4-propagated from `at`) as a thin line.
 * `glow` adds a wide, faint underlay so the line reads as softly glowing (focus mode).
 */
export function SelectedOrbit({
  entry,
  at,
  color = PALETTE.gold,
  glow = false,
  faint = false,
}: {
  entry: CatalogEntry | null;
  at: number;
  color?: string;
  glow?: boolean;
  /** Recede behind other focus lines (e.g. an avoidance plan). */
  faint?: boolean;
}) {
  const points = useMemo(() => {
    if (!entry) return null;
    const s = toSatrec(entry);
    if (!s) return null;
    const pts = orbitPath(s, new Date(at));
    return pts.length > 2 ? pts : null;
  }, [entry, at]);

  if (!points) return null;
  return (
    <group>
      {glow && <Line points={points} color={color} lineWidth={5} transparent opacity={0.12} depthWrite={false} />}
      <Line points={points} color={color} lineWidth={glow ? 1.4 : 1} transparent opacity={faint ? 0.22 : glow ? 0.9 : 0.75} depthWrite={false} />
    </group>
  );
}
