/* global importScripts, satellite */
/**
 * SGP4 propagation off the main thread (classic worker, bundler-independent).
 * Holds satrecs for the whole catalog; on each "step" returns scene-space positions
 * (Earth radii: xyz + ok flag) and velocities (Earth radii per second) so the GPU can
 * extrapolate smoothly between snapshots. ECI (z = north) maps to the scene as (x, z, -y).
 * Message types are documented in lib/workerProtocol.ts.
 */
importScripts("/vendor/satellite.min.js");

const R_EARTH_KM = 6378.137;
let recs = [];
let gen = 0;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "set") {
    gen = m.gen;
    recs = m.tles.map(([l1, l2]) => {
      try {
        const s = satellite.twoline2satrec(l1, l2);
        return s.error ? null : s;
      } catch {
        return null;
      }
    });
    return;
  }
  if (m.type === "step" && m.gen === gen) {
    const n = recs.length;
    const pos = new Float32Array(n * 4);
    const vel = new Float32Array(n * 3);
    const date = new Date(m.t);
    for (let i = 0; i < n; i++) {
      const s = recs[i];
      if (!s) continue;
      const pv = satellite.propagate(s, date);
      const p = pv && pv.position;
      const v = pv && pv.velocity;
      if (!p || typeof p === "boolean" || !v || typeof v === "boolean" || !Number.isFinite(p.x)) continue;
      pos[i * 4] = p.x / R_EARTH_KM;
      pos[i * 4 + 1] = p.z / R_EARTH_KM;
      pos[i * 4 + 2] = -p.y / R_EARTH_KM;
      pos[i * 4 + 3] = 1;
      vel[i * 3] = v.x / R_EARTH_KM;
      vel[i * 3 + 1] = v.z / R_EARTH_KM;
      vel[i * 3 + 2] = -v.y / R_EARTH_KM;
    }
    self.postMessage({ type: "step", gen, t: m.t, pos, vel }, [pos.buffer, vel.buffer]);
  }
};
