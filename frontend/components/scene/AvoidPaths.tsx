"use client";

import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import type { Vec3 } from "@/lib/orbit";
import { PATH_COLORS } from "@/lib/theme";

/** Avoidance plan drawn in focus mode (scene units = Earth radii). */
export interface AvoidScene {
  original: Vec3[];
  burned: Vec3[];
  other: Vec3[] | null;
  burnPoint: Vec3;
  tcaOriginal: Vec3;
  tcaBurned: Vec3;
  burnLabel: string;
  tcaLabel: string;
  newMissLabel: string | null;
  /** Index where the final approach starts (half an orbit before TCA); earlier laps are drawn faint. */
  split: number;
  /** Dash length scale: 1 at globe zoom, much smaller in the close-up at TCA. */
  dash: number;
}

// Drawn after the object points (renderOrder 0, no depth write) so the paths sit on top of them; depth test stays on
// so the Earth still hides the far side.
const ORDER = 8;
const scratch = new THREE.Vector3();
const toPoint = new THREE.Vector3();

/** True if the Earth (unit sphere) blocks the line of sight from the camera to p. */
function hiddenByEarth(cam: THREE.Vector3, p: Vec3): boolean {
  toPoint.set(p[0], p[1], p[2]).sub(cam);
  const len = toPoint.length();
  toPoint.divideScalar(len);
  const t = -cam.dot(toPoint); // closest approach of the ray to the Earth's centre
  if (t <= 0 || t >= len) return false;
  scratch.copy(cam).addScaledVector(toPoint, t);
  return scratch.lengthSq() < 0.995 * 0.995;
}

/** Small dot + text label at a point; fades out while the Earth is in front of it. */
function Marker({ point, color, label, side = "right", dy = 0 }: { point: Vec3; color: string; label: string; side?: "right" | "left"; dy?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useFrame(({ camera }) => {
    if (box.current) box.current.style.opacity = hiddenByEarth(camera.position, point) ? "0" : "1";
  });
  return (
    <Html position={point} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
      <div ref={box} className="relative transition-opacity duration-300" style={{ transform: "translate(-50%, -50%)" }}>
        <span
          className="block h-[9px] w-[9px] rounded-full"
          style={{ background: color, boxShadow: `0 0 0 2px rgb(5 6 10 / 0.9), 0 0 10px ${color}` }}
        />
        <span
          className="absolute top-1/2 whitespace-nowrap rounded-md border border-white/10 bg-black/60 px-1.5 py-px font-mono text-[14px] text-ivory backdrop-blur-sm"
          style={
            side === "right"
              ? { left: 14, transform: `translateY(calc(-50% + ${dy}px))` }
              : { right: 14, transform: `translateY(calc(-50% + ${dy}px))` }
          }
        >
          {label}
        </span>
      </div>
    </Html>
  );
}

/** Earlier laps (burn → final approach): thin and faint, so stacked revolutions do not read as a band. */
function EarlyLap({ points, color, dashed = false, dash }: { points: Vec3[]; color: string; dashed?: boolean; dash: number }) {
  if (points.length < 2) return null;
  return (
    <Line
      points={points}
      color={color}
      lineWidth={1.2}
      dashed={dashed}
      dashSize={0.035 * dash}
      gapSize={0.02 * dash}
      transparent
      opacity={0.35}
      depthWrite={false}
      renderOrder={ORDER}
    />
  );
}

export function AvoidPaths({ a }: { a: AvoidScene }) {
  // The final approach (half an orbit before TCA → TCA + 30 min) is drawn strong; the split point is shared.
  const k = Math.max(0, Math.min(a.split, a.original.length - 2));
  const recent = (p: Vec3[]) => p.slice(Math.min(k, Math.max(0, p.length - 2)));
  const early = (p: Vec3[]) => p.slice(0, k + 1);
  const original = recent(a.original);
  const burned = recent(a.burned);
  return (
    <group>
      <EarlyLap points={early(a.original)} color={PATH_COLORS.risk} dashed dash={a.dash} />
      <EarlyLap points={early(a.burned)} color={PATH_COLORS.optimal} dash={a.dash} />
      {a.other && <EarlyLap points={early(a.other)} color={PATH_COLORS.other} dash={a.dash} />}
      {a.other && a.other.length > 1 && (
        <Line points={recent(a.other)} color={PATH_COLORS.other} lineWidth={2} transparent opacity={0.8} depthWrite={false} renderOrder={ORDER} />
      )}
      {/* Current (risky) path: rose, dashed so it stays distinct from the green path without colour vision. */}
      <Line points={original} color={PATH_COLORS.risk} lineWidth={5} transparent opacity={0.1} depthWrite={false} renderOrder={ORDER} />
      <Line
        points={original}
        color={PATH_COLORS.risk}
        lineWidth={2.6}
        dashed
        dashSize={0.035 * a.dash}
        gapSize={0.02 * a.dash}
        transparent
        opacity={0.95}
        depthWrite={false}
        renderOrder={ORDER + 3}
      />
      <Line points={burned} color={PATH_COLORS.optimal} lineWidth={5} transparent opacity={0.12} depthWrite={false} renderOrder={ORDER} />
      {/* Green under the red dashes: the two paths are often < 1 km apart, so both must stay visible where they coincide. */}
      <Line points={burned} color={PATH_COLORS.optimal} lineWidth={3.6} transparent opacity={0.95} depthWrite={false} renderOrder={ORDER + 2} />
      {/* Fixed label offsets: a burn a whole number of orbits before TCA sits almost on the TCA point. */}
      <Marker point={a.burnPoint} color={PATH_COLORS.optimal} label={a.burnLabel} dy={16} />
      <Marker point={a.tcaOriginal} color={PATH_COLORS.risk} label={a.tcaLabel} side="left" />
      {a.newMissLabel && <Marker point={a.tcaBurned} color={PATH_COLORS.optimal} label={a.newMissLabel} dy={-16} />}
    </group>
  );
}
