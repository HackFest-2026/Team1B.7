import { gstime, propagate, sunPos, jday, twoline2satrec, type SatRec } from "satellite.js";
import type { CatalogEntry } from "./api";

/** Earth equatorial radius in km. Scene units are Earth radii. */
export const R_EARTH_KM = 6378.137;
const MU_EARTH = 398600.4418; // km^3/s^2
const DAY_MS = 86_400_000;

export type Vec3 = [number, number, number];

export function toSatrec(tle: { tle1: string; tle2: string }): SatRec | null {
  try {
    return twoline2satrec(tle.tle1, tle.tle2);
  } catch {
    return null;
  }
}

export function toSatrecs(tles: { tle1: string; tle2: string }[]): (SatRec | null)[] {
  return tles.map(toSatrec);
}

/** ECI km (z = north) -> scene Earth radii with +Y up: (x, z, -y). */
function eciToScene(p: { x: number; y: number; z: number }): Vec3 {
  return [p.x / R_EARTH_KM, p.z / R_EARTH_KM, -p.y / R_EARTH_KM];
}

/** TEME/ECI km (as returned by the backend) -> scene Earth radii. */
export function temeToScene(p: [number, number, number]): Vec3 {
  return eciToScene({ x: p[0], y: p[1], z: p[2] });
}

/** Scene-space position at `date`, or null if SGP4 fails (e.g. decayed). */
export function positionAt(satrec: SatRec, date: Date): Vec3 | null {
  const p = propagate(satrec, date)?.position;
  if (!p || typeof p === "boolean" || !Number.isFinite(p.x)) return null;
  return eciToScene(p);
}

/**
 * Propagate all satrecs to `date` and write scene-space positions into `out`
 * (length 3*N). `ok[i]` is 1 where propagation succeeded.
 */
export function propagateAll(satrecs: (SatRec | null)[], date: Date, out: Float32Array, ok: Uint8Array): void {
  for (let i = 0; i < satrecs.length; i++) {
    const s = satrecs[i];
    const v = s ? positionAt(s, date) : null;
    if (!v) {
      ok[i] = 0;
      continue;
    }
    ok[i] = 1;
    out[i * 3] = v[0];
    out[i * 3 + 1] = v[1];
    out[i * 3 + 2] = v[2];
  }
}

/** Orbital period in minutes from SGP4 mean motion (rad/min). */
export function periodMinutes(satrec: SatRec): number {
  return (2 * Math.PI) / satrec.no;
}

export function inclinationDeg(satrec: SatRec): number {
  return (satrec.inclo * 180) / Math.PI;
}

/** One full revolution starting at `date`, sampled `n` times, in scene space. */
export function orbitPath(satrec: SatRec, date: Date, n = 256): Vec3[] {
  const periodMs = periodMinutes(satrec) * 60_000;
  const pts: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const p = positionAt(satrec, new Date(date.getTime() + (k / n) * periodMs));
    if (p) pts.push(p);
  }
  return pts;
}

/** Greenwich sidereal angle (rad); rotating the Earth mesh by this about +Y aligns ECEF with ECI. */
export function earthRotation(date: Date): number {
  return gstime(date);
}

/** Unit vector toward the Sun in scene space. */
export function sunDirection(date: Date): Vec3 {
  const { rsun } = sunPos(jday(date));
  const [x, y, z] = rsun; // ECI, AU
  const v: Vec3 = [x, z, -y];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function medianTleAgeHours(epochs: string[], now: Date): number | null {
  if (epochs.length === 0) return null;
  const ages = epochs.map((e) => (now.getTime() - Date.parse(e)) / 3.6e6).sort((a, b) => a - b);
  return ages[Math.floor(ages.length / 2)];
}

/** Assumed isotropic 1-sigma position error (CLAUDE.md physics rules): 0.5 km + 1 km per day of TLE age. */
export function assumedSigmaKm(tleAgeDays: number): number {
  return 0.5 + 1.0 * Math.abs(tleAgeDays);
}

/** TLE epoch as a JS Date (from the satrec's Julian date). */
export function tleEpoch(satrec: SatRec): Date {
  return new Date((satrec.jdsatepoch - 2440587.5) * DAY_MS);
}

export interface ParsedTle {
  entry: CatalogEntry;
  epoch: Date;
  ageDays: number;
}

/**
 * Parse a pasted 2- or 3-line TLE into a catalog entry. Throws an Error with a readable
 * message if the lines are malformed or SGP4 cannot propagate them.
 */
export function parsePastedTle(text: string, now: Date): ParsedTle {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const i1 = lines.findIndex((l) => l.startsWith("1 "));
  if (i1 < 0 || !lines[i1 + 1]?.startsWith("2 ")) {
    throw new Error("Expected line 1 starting with \"1 \" followed by line 2 starting with \"2 \".");
  }
  const l1 = lines[i1];
  const l2 = lines[i1 + 1];
  if (l1.length < 69 || l2.length < 69) throw new Error("TLE lines must be 69 characters long.");
  const name = (i1 > 0 ? lines[i1 - 1].replace(/^0 /, "").trim() : "") || "Pasted object";

  let satrec: SatRec;
  try {
    satrec = twoline2satrec(l1, l2);
  } catch {
    throw new Error("Could not parse these TLE lines.");
  }
  if (satrec.error || !positionAt(satrec, now)) throw new Error("SGP4 cannot propagate this element set to the current time.");

  const n = satrec.no / 60; // rad/s
  const a = Math.cbrt(MU_EARTH / (n * n));
  const epoch = tleEpoch(satrec);
  const entry: CatalogEntry = {
    norad: Number.parseInt(satrec.satnum, 10),
    name,
    object_type: "UNKNOWN",
    type_source: "pasted",
    group: "pasted",
    tle1: l1,
    tle2: l2,
    epoch: epoch.toISOString(),
    perigee_km: Math.round((a * (1 - satrec.ecco) - R_EARTH_KM) * 10) / 10,
    apogee_km: Math.round((a * (1 + satrec.ecco) - R_EARTH_KM) * 10) / 10,
  };
  return { entry, epoch, ageDays: (now.getTime() - epoch.getTime()) / DAY_MS };
}
