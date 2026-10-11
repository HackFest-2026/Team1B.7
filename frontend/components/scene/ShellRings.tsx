"use client";

import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { R_EARTH_KM, type Vec3 } from "@/lib/orbit";
import { PALETTE } from "@/lib/theme";

/** Reference altitudes (km): LEO upper bound, GNSS-like MEO, geostationary. */
const SHELLS = [
  { label: "LEO", altKm: 2000 },
  { label: "MEO", altKm: 20200 },
  { label: "GEO", altKm: 35786 },
] as const;

const LABEL_PX = 20; // on-screen label height in CSS pixels
const CANVAS_H = 64;

function circle(r: number, n = 192): Vec3[] {
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return [r * Math.cos(a), 0, r * Math.sin(a)];
  });
}

/** Draw "LEO  2,000 km" onto a canvas in the page's body font (rendered in-scene, no extra React root). */
function drawLabel(canvas: HTMLCanvasElement, label: string, altKm: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim() || "monospace";
  const main = `600 ${CANVAS_H * 0.5}px ${family}`;
  const sub = `500 ${CANVAS_H * 0.42}px ${mono}`;
  const alt = `${altKm.toLocaleString()} km`;
  ctx.font = main;
  const w1 = ctx.measureText(label).width;
  ctx.font = sub;
  const w2 = ctx.measureText(alt).width;
  canvas.width = Math.ceil(w1 + w2 + CANVAS_H * 0.5);
  canvas.height = CANVAS_H;
  ctx.textBaseline = "middle";
  ctx.font = main;
  ctx.fillStyle = PALETTE.ivory;
  ctx.globalAlpha = 0.85;
  ctx.fillText(label, 0, CANVAS_H / 2);
  ctx.font = sub;
  ctx.fillStyle = PALETTE.muted;
  ctx.globalAlpha = 0.9;
  ctx.fillText(alt, w1 + CANVAS_H * 0.3, CANVAS_H / 2);
}

const scratch = new THREE.Vector3();

/** Label sprite pinned to the ring's right-hand edge as seen from the camera, constant pixel size. */
function RingLabel({ r, label, altKm }: { r: number; label: string; altKm: number }) {
  const sprite = useRef<THREE.Sprite>(null);
  const material = useRef<THREE.SpriteMaterial>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Texture lives outside React state; the material gets it once drawn (and again after web fonts load).
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvasRef.current = canvas;
    let texture: THREE.CanvasTexture | null = null;
    let cancelled = false;
    const draw = () => {
      if (cancelled || !material.current) return;
      drawLabel(canvas, label, altKm);
      texture?.dispose(); // canvas size may change, so build a fresh texture
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      material.current.map = texture;
      material.current.needsUpdate = true;
    };
    draw();
    void document.fonts?.ready.then(draw);
    return () => {
      cancelled = true;
      texture?.dispose();
    };
  }, [label, altKm]);

  useFrame(({ camera, size }) => {
    const s = sprite.current;
    const canvas = canvasRef.current;
    if (!s || !canvas) return;
    const right = scratch.setFromMatrixColumn(camera.matrixWorld, 0);
    right.y = 0;
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize().multiplyScalar(r * 1.015);
    s.position.copy(right);
    // Constant on-screen height regardless of zoom.
    const persp = camera as THREE.PerspectiveCamera;
    const dist = camera.position.distanceTo(s.position);
    const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / size.height;
    const h = LABEL_PX * worldPerPx;
    s.scale.set((h * canvas.width) / Math.max(canvas.height, 1), h, 1);
  });

  return (
    <sprite ref={sprite} center={[0, 0.5]} renderOrder={10}>
      <spriteMaterial ref={material} transparent depthTest={false} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

/** Thin, faint equatorial reference rings for the LEO / MEO / GEO regimes. */
export function ShellRings() {
  const rings = useMemo(
    () => SHELLS.map((s) => ({ ...s, r: 1 + s.altKm / R_EARTH_KM, pts: circle(1 + s.altKm / R_EARTH_KM) })),
    [],
  );
  return (
    <group>
      {rings.map((s) => (
        <group key={s.label}>
          <Line points={s.pts} color={PALETTE.ivory} lineWidth={0.6} transparent opacity={0.12} depthWrite={false} />
          <RingLabel r={s.r} label={s.label} altKm={s.altKm} />
        </group>
      ))}
    </group>
  );
}
