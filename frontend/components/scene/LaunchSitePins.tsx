"use client";

import { Billboard, Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { earthRotation, type Vec3 } from "@/lib/orbit";
import { simNow } from "@/lib/simClock";
import { PALETTE } from "@/lib/theme";

const SURFACE_R = 1.003; // just above the surface so pins never z-fight the Earth
const PIN_PX = 7;
const PICK_PX = 12;
const CLICK_SLOP_PX = 5;
const ORDER = 9; // after the object points (renderOrder 0, no depth write): pins sit on top of them

/** Earth-fixed (ECEF) unit vector in scene axes (x, z, −y); the parent group turns it by GMST like the Earth mesh. */
export function siteEcefScene(lat: number, lon: number, r = SURFACE_R): Vec3 {
  const la = THREE.MathUtils.degToRad(lat);
  const lo = THREE.MathUtils.degToRad(lon);
  return [r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo)];
}

/** Inertial scene position of a site at `t` (ms): the Earth-fixed point turned by GMST about +Y. */
export function siteScenePosition(lat: number, lon: number, t: number, r = SURFACE_R): Vec3 {
  const [x, y, z] = siteEcefScene(lat, lon, r);
  const g = earthRotation(new Date(t));
  const c = Math.cos(g);
  const s = Math.sin(g);
  return [x * c + z * s, y, -x * s + z * c];
}

export interface PinSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  indian: boolean;
}

const v = new THREE.Vector3();
const toCam = new THREE.Vector3();

function Pin({ site, selected, hovered }: { site: PinSite; selected: boolean; hovered: boolean }) {
  const group = useRef<THREE.Group>(null);
  const pos = useMemo(() => siteEcefScene(site.lat, site.lon), [site.lat, site.lon]);
  const color = site.indian ? PALETTE.gold : PALETTE.silver;
  useFrame(({ camera, size }) => {
    const g = group.current;
    if (!g) return;
    g.getWorldPosition(v);
    const persp = camera as THREE.PerspectiveCamera;
    const worldPerPx = (2 * camera.position.distanceTo(v) * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / size.height;
    g.scale.setScalar((PIN_PX * worldPerPx) / 2);
  });
  const big = selected || hovered;
  return (
    <Billboard position={pos}>
      <group ref={group}>
        {/* dark outline so the pin reads on bright land and over the object points */}
        <mesh renderOrder={ORDER}>
          <circleGeometry args={[big ? 1.55 : 1.35, 24]} />
          <meshBasicMaterial color={PALETTE.space} transparent opacity={0.85} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh renderOrder={ORDER + 1}>
          <circleGeometry args={[big ? 1.2 : 1, 24]} />
          <meshBasicMaterial color={color} transparent opacity={site.indian ? 1 : 0.8} depthWrite={false} toneMapped={false} />
        </mesh>
        {selected && (
          <mesh renderOrder={ORDER + 1}>
            <ringGeometry args={[2.2, 2.6, 40]} />
            <meshBasicMaterial color={PALETTE.gold} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
          </mesh>
        )}
      </group>
    </Billboard>
  );
}

/**
 * Launch-site pins on the Earth's surface. The group turns by GMST every frame, exactly like the Earth mesh, so pins
 * stay on their coastlines. Hover and click use screen-space picking (pins are tiny); a pin click is consumed in the
 * capture phase so the object picker underneath does not also select a satellite.
 */
export function LaunchSitePins({
  sites,
  selectedId,
  hoveredId,
  onHover,
  onPick,
}: {
  sites: PinSite[];
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onPick: (id: string) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const { gl, camera } = useThree();
  const local = useMemo(() => sites.map((s) => new THREE.Vector3(...siteEcefScene(s.lat, s.lon))), [sites]);

  useFrame(() => {
    if (group.current) group.current.rotation.y = earthRotation(new Date(simNow()));
  });

  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    let hover: string | null = null;
    const nearest = (e: PointerEvent): string | null => {
      const g = group.current;
      if (!g) return null;
      g.updateMatrixWorld();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let best: string | null = null;
      let bestD = PICK_PX;
      for (let i = 0; i < local.length; i++) {
        v.copy(local[i]).applyMatrix4(g.matrixWorld);
        // facing the camera = not on the far side of the Earth
        toCam.copy(camera.position).sub(v);
        if (toCam.dot(v) <= 0) continue;
        v.project(camera);
        if (v.z > 1) continue;
        const d = Math.hypot((v.x * 0.5 + 0.5) * rect.width - px, (-v.y * 0.5 + 0.5) * rect.height - py);
        if (d < bestD) {
          bestD = d;
          best = sites[i].id;
        }
      }
      return best;
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const id = nearest(e);
      if (id !== hover) {
        hover = id;
        onHover(id);
        el.style.cursor = id ? "pointer" : "";
      }
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
      down = null;
      const id = nearest(e);
      if (id) {
        e.stopImmediatePropagation(); // the object picker listens on the same element
        onPick(id);
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown, { capture: true });
    el.addEventListener("pointerup", onUp, { capture: true });
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown, { capture: true });
      el.removeEventListener("pointerup", onUp, { capture: true });
      el.style.cursor = "";
    };
  }, [gl, camera, local, sites, onHover, onPick]);

  const hovered = hoveredId ? sites.find((s) => s.id === hoveredId) : null;
  return (
    <group ref={group}>
      {sites.map((s) => (
        <Pin key={s.id} site={s} selected={s.id === selectedId} hovered={s.id === hoveredId} />
      ))}
      {hovered && (
        <Html position={siteEcefScene(hovered.lat, hovered.lon)} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
          <div
            className="whitespace-nowrap rounded-md border border-white/10 bg-black/70 px-2 py-0.5 text-[14px] text-ivory backdrop-blur-sm"
            style={{ transform: "translate(12px, -50%)" }}
          >
            {hovered.name}
          </div>
        </Html>
      )}
    </group>
  );
}
