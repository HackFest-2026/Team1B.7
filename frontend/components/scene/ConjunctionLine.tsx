"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { CatalogEntry } from "@/lib/api";
import { positionAt, toSatrec } from "@/lib/orbit";
import { simNow } from "@/lib/simClock";
import { PALETTE } from "@/lib/theme";

/**
 * Thin rose line between the two objects of the focused conjunction, recomputed with SGP4 at the
 * simulated time every frame. When the clock sits at TCA it shows the closest approach itself.
 */
export function ConjunctionLine({ a, b }: { a: CatalogEntry; b: CatalogEntry }) {
  const recs = useMemo(() => [toSatrec(a), toSatrec(b)] as const, [a, b]);
  const line = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineBasicMaterial({ color: PALETTE.rose, transparent: true, opacity: 0.95, depthTest: false });
    const l = new THREE.Line(geo, mat);
    l.frustumCulled = false;
    l.renderOrder = 5;
    return l;
  }, []);

  const ref = useRef<THREE.Line>(null);

  useEffect(() => {
    const l = ref.current;
    return () => {
      l?.geometry.dispose();
      (l?.material as THREE.Material | undefined)?.dispose();
    };
  }, [line]);

  useFrame(() => {
    const l = ref.current;
    if (!l) return;
    const [ra, rb] = recs;
    const t = new Date(simNow());
    const pa = ra && positionAt(ra, t);
    const pb = rb && positionAt(rb, t);
    l.visible = Boolean(pa && pb);
    if (!pa || !pb) return;
    const attr = l.geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(0, ...pa);
    attr.setXYZ(1, ...pb);
    attr.needsUpdate = true;
  });

  return <primitive ref={ref} object={line} />;
}
