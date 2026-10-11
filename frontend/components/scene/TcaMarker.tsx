"use client";

import { Billboard } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Vec3 } from "@/lib/orbit";
import { PALETTE } from "@/lib/theme";

const RING_PX = 26; // on-screen diameter at rest
const scratch = new THREE.Vector3();

/** Soft, slowly pulsing rose ring marking the point of closest approach (constant pixel size). */
export function TcaMarker({ point, color = PALETTE.rose }: { point: Vec3; color?: string }) {
  const group = useRef<THREE.Group>(null);
  const halo = useRef<THREE.MeshBasicMaterial>(null);
  const reduced = useRef(false);
  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useFrame(({ camera, size, clock }) => {
    const g = group.current;
    if (!g) return;
    const persp = camera as THREE.PerspectiveCamera;
    const dist = camera.position.distanceTo(scratch.set(...point));
    const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / size.height;
    const t = reduced.current ? 0 : clock.getElapsedTime();
    const pulse = 1 + 0.18 * Math.sin(t * 1.6);
    g.scale.setScalar(((RING_PX * worldPerPx) / 2) * pulse);
    if (halo.current) halo.current.opacity = 0.16 + 0.08 * Math.sin(t * 1.6);
  });

  return (
    <Billboard position={point}>
      <group ref={group}>
        <mesh renderOrder={6}>
          <ringGeometry args={[0.82, 1, 64]} />
          <meshBasicMaterial color={color} transparent opacity={0.85} depthTest={false} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh renderOrder={5} scale={1.9}>
          <ringGeometry args={[0.45, 1, 64]} />
          <meshBasicMaterial
            ref={halo}
            color={color}
            transparent
            opacity={0.18}
            blending={THREE.AdditiveBlending}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>
    </Billboard>
  );
}
