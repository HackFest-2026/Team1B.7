"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { objectType, type CatalogEntry, type ObjectType } from "@/lib/api";
import { PROPAGATE_WORKER_URL, type WorkerIn, type WorkerOut } from "@/lib/workerProtocol";
import { simNow, simSpeed } from "@/lib/simClock";
import { PALETTE, TYPE_COLORS } from "@/lib/theme";

// Sprite diameter in Earth radii; the soft falloff makes the visible core much smaller.
const TYPE_SIZE: Record<ObjectType, number> = { payload: 0.016, rocket: 0.017, debris: 0.011, unknown: 0.011 };
// Default-view brightness per type: debris recedes so satellites read first.
const TYPE_BRIGHTNESS: Record<ObjectType, number> = { payload: 0.85, rocket: 0.7, debris: 0.42, unknown: 0.4 };
/** Seconds-scale ease for the focus fade. */
const FOCUS_EASE = 3;
const PICK_RADIUS_PX = 14;
const CLICK_SLOP_PX = 5;
/** GM of Earth in Earth radii^3 / s^2, matching the shader's extrapolation. */
const MU_RADII = 398600.4418 / 6378.137 ** 3;
/** Beyond this gap (sim seconds) linear extrapolation drifts visibly, so re-propagate right away. */
const MAX_EXTRAPOLATION_S = 360; // 2nd-order error at 360 s is ~70 km (ISS test); beyond that, refresh

export type LayerVisibility = Record<ObjectType, boolean>;

const FLAG_NONE = 0;
const FLAG_ALERT = 1;
const FLAG_SELECTED = 2;
const FLAG_FOCUS_PRIMARY = 3; // protected asset in focus mode (ice blue)
const FLAG_FOCUS_THREAT = 4; // threat object in focus mode (rose)
const FLAG_FOCUS_REENTRY = 5; // re-entry object in focus mode (amber)

/** Objects highlighted in focus mode; everything else fades to ~10%. */
export interface FocusRoles {
  primary?: number;
  threat?: number;
  reentry?: number;
}

/** Real-time interval between SGP4 snapshots for a given sim speed (throttled updates). */
function snapshotIntervalMs(speed: number): number {
  if (speed <= 1) return 1000;
  if (speed <= 10) return 500;
  if (speed <= 100) return 300;
  return 200;
}

const vertexShader = /* glsl */ `
  attribute vec4 aPos;   // xyz Earth radii at snapshot time, w = 1 if propagated
  attribute vec3 aVel;   // Earth radii per second
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aFlag;
  uniform float uDt;     // sim seconds since snapshot
  const float MU = 1.53623e-6; // GM of Earth in Earth radii^3 / s^2 (398600.4418 / 6378.137^3)
  uniform float uTime;
  uniform float uFocus;  // 0 = normal view, 1 = focus mode (others faded)
  uniform vec3 uGold;
  uniform vec3 uRose;
  uniform vec3 uIce;
  uniform vec3 uAmber;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    if (aPos.w < 0.5 || aSize <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // Second-order (two-body gravity) extrapolation between SGP4 snapshots: smooth motion
    // without re-propagating every frame; the next snapshot corrects any drift.
    float r = length(aPos.xyz);
    vec3 acc = -MU * aPos.xyz / (r * r * r);
    vec3 center = aPos.xyz + aVel * uDt + 0.5 * acc * uDt * uDt;

    // Hidden behind Earth: does the camera ray hit the unit sphere before reaching the point?
    vec3 toP = center - cameraPosition;
    float L = length(toP);
    vec3 dir = toP / L;
    float b = dot(cameraPosition, dir);
    float disc = b * b - (dot(cameraPosition, cameraPosition) - 1.0);
    if (disc > 0.0) {
      float tHit = -b - sqrt(disc);
      if (tHit > 0.0 && tHit < L) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    }

    vec4 mv = modelViewMatrix * vec4(center, 1.0);
    vec3 c = aColor;
    float k = 1.0;
    float pulse = 0.35 * sin(uTime * 1.5);
    if (aFlag > 4.5) { c = uAmber; k = 2.8 + pulse; }
    else if (aFlag > 3.5) { c = uRose; k = 2.8 - pulse; }
    else if (aFlag > 2.5) { c = uIce; k = 2.8 + pulse; }
    else {
      if (aFlag > 1.5) { c = uGold; k = 2.6; }
      else if (aFlag > 0.5) { c = uRose; k = 1.9 + 0.5 * sin(uTime * 1.6); }
      c *= mix(1.0, 0.1, uFocus);
    }
    // Constant pixel size up close too (close-up at TCA views the encounter from tens of km).
    float distScale = clamp(-mv.z / 3.5, 0.0005, 1.6);
    mv.xy += position.xy * aSize * k * distScale;
    vColor = c;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = 1.0 - d;
    float intensity = pow(a, 4.0) * 1.3 + a * a * 0.22;
    gl_FragColor = vec4(vColor * intensity, 1.0);
    #include <colorspace_fragment>
  }
`;

interface Props {
  catalog: CatalogEntry[];
  layers: LayerVisibility;
  selected: number | null;
  alerts: ReadonlySet<number>;
  onSelect: (norad: number) => void;
  focus: FocusRoles | null;
  /** Reports measured frames per second about once a second. */
  onFps?: (fps: number) => void;
}

/** Every catalog object as ONE InstancedMesh of glow sprites; SGP4 runs in a Web Worker. */
export function ObjectField(props: Props) {
  if (props.catalog.length === 0) return null;
  // key: fresh buffers when the object count changes (catalog load, lookup, pasted TLE)
  return <Instances key={props.catalog.length} {...props} />;
}

function Instances({ catalog, layers, selected, alerts, onSelect, focus, onFps }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const count = catalog.length;
  const { camera, gl } = useThree();

  const types = useMemo(() => catalog.map(objectType), [catalog]);

  const attrs = useMemo(() => {
    const color = new Float32Array(count * 3);
    const cache = new Map<ObjectType, THREE.Color>();
    types.forEach((t, i) => {
      if (!cache.has(t)) cache.set(t, new THREE.Color(TYPE_COLORS[t]).multiplyScalar(TYPE_BRIGHTNESS[t]));
      cache.get(t)!.toArray(color, i * 3);
    });
    return {
      pos: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage),
      vel: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage),
      color: new THREE.InstancedBufferAttribute(color, 3),
      size: new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
      flag: new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
    };
  }, [count, types]);

  const uniforms = useMemo(
    () => ({
      uDt: { value: 0 },
      uTime: { value: 0 },
      uFocus: { value: 0 },
      uGold: { value: new THREE.Color(PALETTE.gold) },
      uIce: { value: new THREE.Color(PALETTE.ice) },
      uAmber: { value: new THREE.Color(PALETTE.amber) },
      uRose: { value: new THREE.Color(PALETTE.rose) },
    }),
    [],
  );

  // CPU copy of the latest snapshot, for picking.
  const snap = useRef<{ t: number; pos: Float32Array; vel: Float32Array } | null>(null);
  const worker = useRef<Worker | null>(null);
  const gen = useRef(0);
  const inFlight = useRef(false);
  const lastRequest = useRef(0);
  const fps = useRef({ frames: 0, since: 0 });

  // Worker lifecycle: load TLEs, receive snapshots.
  useEffect(() => {
    const w = new Worker(PROPAGATE_WORKER_URL);
    worker.current = w;
    const g = ++gen.current;
    w.postMessage({ type: "set", gen: g, tles: catalog.map((c) => [c.tle1, c.tle2]) } satisfies WorkerIn);
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      inFlight.current = false;
      if (m.gen !== gen.current) return;
      const mesh = meshRef.current;
      if (!mesh) return;
      const geo = mesh.geometry;
      const pos = geo.getAttribute("aPos") as THREE.InstancedBufferAttribute;
      const vel = geo.getAttribute("aVel") as THREE.InstancedBufferAttribute;
      (pos.array as Float32Array).set(m.pos);
      (vel.array as Float32Array).set(m.vel);
      pos.needsUpdate = true;
      vel.needsUpdate = true;
      snap.current = { t: m.t, pos: m.pos, vel: m.vel };
    };
    return () => {
      w.terminate();
      worker.current = null;
      inFlight.current = false;
    };
  }, [catalog]);

  // Sizes (layer visibility) and flags (selected / alert).
  useEffect(() => {
    const attr = meshRef.current?.geometry.getAttribute("aSize");
    if (!attr) return;
    const a = attr.array as Float32Array;
    types.forEach((t, i) => (a[i] = layers[t] ? TYPE_SIZE[t] : 0));
    attr.needsUpdate = true;
  }, [types, layers, attrs]);

  useEffect(() => {
    const attr = meshRef.current?.geometry.getAttribute("aFlag");
    if (!attr) return;
    const f = attr.array as Float32Array;
    catalog.forEach((c, i) => {
      const n = c.norad;
      f[i] =
        focus?.primary === n
          ? FLAG_FOCUS_PRIMARY
          : focus?.threat === n
            ? FLAG_FOCUS_THREAT
            : focus?.reentry === n
              ? FLAG_FOCUS_REENTRY
              : n === selected
                ? FLAG_SELECTED
                : alerts.has(n)
                  ? FLAG_ALERT
                  : FLAG_NONE;
    });
    attr.needsUpdate = true;
  }, [catalog, selected, alerts, focus, attrs]);

  const reducedMotion = useRef(false);
  useEffect(() => {
    reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  const focusOn = Boolean(focus);

  useFrame(({ clock }, delta) => {
    const mat = matRef.current;
    if (!mat) return;
    const now = performance.now();
    const t = simNow();

    // Measure fps.
    if (fps.current.since === 0) fps.current.since = now;
    fps.current.frames++;
    if (now - fps.current.since >= 1000) {
      onFps?.((fps.current.frames * 1000) / (now - fps.current.since));
      fps.current = { frames: 0, since: now };
    }

    const s = snap.current;
    const dtSim = s ? (t - s.t) / 1000 : Infinity;
    mat.uniforms.uTime.value = reducedMotion.current ? 0 : clock.getElapsedTime();
    mat.uniforms.uDt.value = Number.isFinite(dtSim) ? dtSim : 0;
    // Ease the fade of non-focused objects in and out.
    const target = focusOn ? 1 : 0;
    const cur = mat.uniforms.uFocus.value as number;
    mat.uniforms.uFocus.value = reducedMotion.current ? target : cur + (target - cur) * Math.min(1, delta * FOCUS_EASE);

    const w = worker.current;
    if (!w || inFlight.current) return;
    const speed = simSpeed();
    // Paused: one snapshot at the current time is enough.
    const due = speed > 0 && now - lastRequest.current >= snapshotIntervalMs(speed);
    if (!s || due || Math.abs(dtSim) > MAX_EXTRAPOLATION_S || (speed === 0 && dtSim !== 0)) {
      inFlight.current = true;
      lastRequest.current = now;
      w.postMessage({ type: "step", gen: gen.current, t } satisfies WorkerIn);
    }
  });

  // Screen-space picking against extrapolated positions, skipping points hidden behind Earth.
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const v = new THREE.Vector3();
    const dir = new THREE.Vector3();

    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const s = snap.current;
      if (!s || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
      down = null;
      const sizeArr = meshRef.current?.geometry.getAttribute("aSize").array as Float32Array | undefined;
      const dt = (simNow() - s.t) / 1000;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const cam = camera.position;
      let best = -1;
      let bestD = PICK_RADIUS_PX;
      for (let i = 0; i < count; i++) {
        if (s.pos[i * 4 + 3] < 0.5 || !sizeArr || sizeArr[i] === 0) continue;
        const x = s.pos[i * 4];
        const y = s.pos[i * 4 + 1];
        const z = s.pos[i * 4 + 2];
        const k = (-0.5 * MU_RADII * dt * dt) / Math.pow(Math.hypot(x, y, z), 3);
        v.set(x + s.vel[i * 3] * dt + k * x, y + s.vel[i * 3 + 1] * dt + k * y, z + s.vel[i * 3 + 2] * dt + k * z);
        dir.copy(v).sub(cam);
        const len = dir.length();
        dir.divideScalar(len);
        const b = cam.dot(dir);
        const disc = b * b - (cam.lengthSq() - 1);
        if (disc > 0) {
          const tHit = -b - Math.sqrt(disc);
          if (tHit > 0 && tHit < len) continue;
        }
        v.project(camera);
        if (v.z > 1) continue;
        const d = Math.hypot((v.x * 0.5 + 0.5) * rect.width - px, (-v.y * 0.5 + 0.5) * rect.height - py);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) onSelect(catalog[best].norad);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [gl, camera, count, catalog, onSelect]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]} frustumCulled={false}>
      <planeGeometry args={[1, 1]}>
        <primitive attach="attributes-aPos" object={attrs.pos} />
        <primitive attach="attributes-aVel" object={attrs.vel} />
        <primitive attach="attributes-aColor" object={attrs.color} />
        <primitive attach="attributes-aSize" object={attrs.size} />
        <primitive attach="attributes-aFlag" object={attrs.flag} />
      </planeGeometry>
      <shaderMaterial
        ref={matRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        depthTest
        transparent
      />
    </instancedMesh>
  );
}
