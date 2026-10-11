import * as THREE from "three";
import type { AvoidPath } from "./api";
import { R_EARTH_KM, temeToScene, type Vec3 } from "./orbit";

/**
 * Geometry for showing an avoidance plan legibly. The real red → green separation is ~1–5 km while the globe view
 * spans thousands of km, so the plan gets (1) a 2D close-up inset, (2) a true-scale camera close-up at TCA and
 * (3) an optional, labelled exaggeration of the perpendicular offset. Physics values are untouched: every number
 * shown comes from /avoid; only the drawing offset is scaled in (3).
 */

const DENSIFY = 4; // 30 s backend step -> 7.5 s (chord sag in LEO ~60 m instead of ~0.9 km)
const VISIBLE_SEP_KM = 400; // exaggerated separation aimed for at globe zoom (~20 px)
const NICE = [1, 2, 5];

export interface Encounter {
  /** Scene units (Earth radii), densified. */
  original: Vec3[];
  burned: Vec3[];
  other: Vec3[] | null;
  split: number;
  burnPoint: Vec3;
  tcaOriginal: Vec3;
  tcaBurned: Vec3;
  /** Per index: burned − original, perpendicular to the current path (scene units). */
  perp: Vec3[];
  /**
   * Per index: |burned − original| along the local horizontal across the track (r̂ × t̂), one sign for the whole
   * path. The real offset of an along-track burn is mostly timing along the path plus a little radial, neither of
   * which separates two lines seen from above, so the exaggerated drawing turns it sideways (the label says so).
   */
  lateral: Vec3[];
  /** Red → green offset at TCA, same instant (km). */
  sepKm: number;
  /** Exaggeration that makes it ~VISIBLE_SEP_KM; 1 when already visible. */
  factor: number;
  /** "Zoom to encounter": pivot at the current TCA point, camera offset (scene units). */
  closeUp: { point: Vec3; offset: Vec3 };
  /** Inset: green passes on the same side of the other object as red (sign of b0 · b1). */
  sameSide: boolean;
}

const sub = (a: Vec3, b: Vec3): THREE.Vector3 => new THREE.Vector3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * Resample a path k× finer with a uniform Catmull-Rom spline (index-uniform = time-uniform). The backend samples
 * every 30 s (~225 km chords, ~0.9 km sag in LEO), too coarse for a true-scale close-up of a 1–5 km encounter.
 */
export function densify(points: Vec3[], k: number): Vec3[] {
  if (points.length < 3 || k <= 1) return points;
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, "catmullrom", 0.5);
  const n = (points.length - 1) * k + 1;
  const out: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = curve.getPoint(i / (n - 1));
    out[i] = [v.x, v.y, v.z];
  }
  return out;
}

/** Round up to 1 / 2 / 5 × 10^k. */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const n of NICE) if (n * p >= x) return n * p;
  return 10 * p;
}

export function buildEncounter(p: AvoidPath, tcaMs: number, periodS: number, missKm: number[]): Encounter {
  const original = densify(p.original_km.map(temeToScene), DENSIFY);
  const burned = densify(p.burned_km.map(temeToScene), DENSIFY);
  const other = p.other_km ? densify(p.other_km.map(temeToScene), DENSIFY) : null;
  const step = p.step_s / DENSIFY;
  const n = Math.min(original.length, burned.length);
  const tcaIdx = Math.max(1, Math.min(n - 2, Math.round((tcaMs - Date.parse(p.start_utc)) / 1000 / step)));
  // Final approach = half an orbit before TCA onward.
  const split = Math.max(0, tcaIdx - Math.round((0.5 * periodS) / step));

  const perp: Vec3[] = new Array(n);
  const full: number[] = new Array(n);
  const side: THREE.Vector3[] = new Array(n);
  const t = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    t.copy(sub(original[Math.min(n - 1, i + 1)], original[Math.max(0, i - 1)])).normalize();
    const d = sub(burned[i], original[i]);
    full[i] = d.length();
    d.addScaledVector(t, -d.dot(t));
    perp[i] = arr(d);
    side[i] = new THREE.Vector3(...original[i]).cross(t).normalize();
  }
  const sideSign = new THREE.Vector3(...perp[tcaIdx]).dot(side[tcaIdx]) < 0 ? -1 : 1;
  const lateral = full.map((m, i) => arr(side[i].clone().multiplyScalar(sideSign * m)));
  // Red -> green offset at TCA (same instant; mostly along-track timing for a T burn).
  const sepKm = full[tcaIdx] * R_EARTH_KM;
  const factor = sepKm > 0 && sepKm < VISIBLE_SEP_KM / 2 ? niceCeil(VISIBLE_SEP_KM / sepKm) : 1;

  // Close-up camera: look across the path (⟂ to the path and to the red → green offset), tilted outward so the
  // Earth stays below; far enough to frame both miss distances.
  const tcaOriginal = temeToScene(p.tca_original_km);
  const tcaBurned = temeToScene(p.tca_burned_km);
  const tan = sub(original[tcaIdx + 1], original[tcaIdx - 1]).normalize();
  const up = new THREE.Vector3(...tcaOriginal).normalize();
  const dp = new THREE.Vector3(...perp[tcaIdx]);
  const across = dp.lengthSq() > 1e-18 ? dp.normalize() : up.clone().cross(tan).normalize();
  const view = tan.clone().cross(across).normalize();
  if (view.dot(up) < 0) view.negate();
  view.addScaledVector(up, 0.35).normalize();
  const spanKm = Math.max(...missKm.filter((m) => Number.isFinite(m)), 0.5);
  const distKm = THREE.MathUtils.clamp(spanKm * 7, 10, 400);

  const b0 = sub(tcaOriginal, temeToScene(p.other_at_tca_km));
  const b1 = p.other_at_new_tca_km ? sub(tcaBurned, temeToScene(p.other_at_new_tca_km)) : null;

  return {
    original,
    burned,
    other,
    split,
    burnPoint: temeToScene(p.burn_point_km),
    tcaOriginal,
    tcaBurned,
    perp,
    lateral,
    sepKm,
    factor,
    closeUp: { point: tcaOriginal, offset: arr(view.multiplyScalar(distKm / R_EARTH_KM)) },
    sameSide: b1 ? b0.dot(b1) >= 0 : true,
  };
}

/** Burned path with its offset from the current path drawn ×n, across the track (drawing only). */
export function exaggerate(e: Encounter, n: number): { burned: Vec3[]; tcaBurned: Vec3 } {
  if (n <= 1) return { burned: e.burned, tcaBurned: e.tcaBurned };
  const k = n;
  const burned = e.burned.map((p, i) => {
    const d = e.lateral[i] ?? [0, 0, 0];
    return [p[0] + k * d[0], p[1] + k * d[1], p[2] + k * d[2]] as Vec3;
  });
  // Shift the new-TCA marker with the offset at its nearest sample.
  let best = 0;
  let bd = Infinity;
  e.burned.forEach((p, i) => {
    const d = (p[0] - e.tcaBurned[0]) ** 2 + (p[1] - e.tcaBurned[1]) ** 2 + (p[2] - e.tcaBurned[2]) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  const d = e.lateral[best] ?? [0, 0, 0];
  return { burned, tcaBurned: [e.tcaBurned[0] + k * d[0], e.tcaBurned[1] + k * d[1], e.tcaBurned[2] + k * d[2]] };
}
