/**
 * Messages for public/workers/propagate.worker.js (a classic worker that loads the vendored
 * satellite.js UMD build, see scripts/vendor-satellite.mjs).
 */
export const PROPAGATE_WORKER_URL = "/workers/propagate.worker.js";

export type WorkerIn =
  | { type: "set"; gen: number; tles: [string, string][] }
  | { type: "step"; gen: number; t: number };

/** pos: 4 floats per object (x, y, z in Earth radii, ok flag); vel: 3 floats (Earth radii / s). */
export type WorkerOut = { type: "step"; gen: number; t: number; pos: Float32Array; vel: Float32Array };
