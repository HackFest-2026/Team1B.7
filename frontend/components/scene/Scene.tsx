"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import type { CatalogEntry } from "@/lib/api";
import type { Vec3 } from "@/lib/orbit";
import { PALETTE } from "@/lib/theme";
import { AvoidPaths, type AvoidScene } from "./AvoidPaths";
import { CameraRig, HOME_DISTANCE, type CloseUp, type Framing, type Insets } from "./CameraRig";
import { ConjunctionLine } from "./ConjunctionLine";
import { LaunchSitePins, type PinSite } from "./LaunchSitePins";
import { Earth } from "./Earth";
import { MilkyWay } from "./MilkyWay";
import { ObjectField, type FocusRoles, type LayerVisibility } from "./ObjectField";
import { SelectedOrbit } from "./SelectedOrbit";
import { ShellRings } from "./ShellRings";
import { Starfield } from "./Starfield";
import { TcaMarker } from "./TcaMarker";

/** Focus mode: highlight a few objects, fade the rest, draw their orbits and markers. */
export interface SceneFocus {
  roles: FocusRoles;
  orbits: { entry: CatalogEntry; color: string }[];
  /** Sim time (ms) the orbit paths start from. */
  at: number;
  /** Two objects to join with a line (conjunction). */
  line: [CatalogEntry, CatalogEntry] | null;
  /** Point of closest approach, marked with a pulsing ring. */
  tcaPoint: Vec3 | null;
  /** Where the camera glides to and holds; null = follow the selection as usual. */
  cameraPoint: Vec3 | null;
  /** Planned avoidance burn: current vs post-burn path and the other object, burn point to TCA + 30 min. */
  avoid?: AvoidScene | null;
  /** "Zoom to encounter": the camera orbits the TCA point from a few tens of km (true scale). */
  closeUp?: CloseUp | null;
}

export interface SceneProps {
  catalog: CatalogEntry[];
  layers: LayerVisibility;
  selected: CatalogEntry | null;
  selectedAt: number;
  alerts: ReadonlySet<number>;
  onSelect: (norad: number) => void;
  onFps?: (fps: number) => void;
  insets: Insets;
  framing: Framing;
  focus: SceneFocus | null;
  /** Launch-site layer (pins turn with the Earth); null hides it. */
  launchSites?: {
    sites: PinSite[];
    selectedId: string | null;
    hoveredId: string | null;
    onHover: (id: string | null) => void;
    onPick: (id: string) => void;
  } | null;
  /** Camera fly-to target outside focus mode (e.g. a launch site); null = normal behaviour. */
  flyTo?: Vec3 | null;
}

export default function Scene({
  catalog,
  layers,
  selected,
  selectedAt,
  alerts,
  onSelect,
  onFps,
  insets,
  framing,
  focus,
  launchSites = null,
  flyTo = null,
}: SceneProps) {
  return (
    <div className="fixed inset-0 cursor-grab touch-none active:cursor-grabbing">
      <Canvas
        camera={{ position: [0, HOME_DISTANCE * 0.28, HOME_DISTANCE * 0.96], fov: 42, near: 0.005, far: 1200 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
        aria-label="3D view of Earth and every tracked object in orbit"
      >
        <color attach="background" args={[PALETTE.space]} />
        <MilkyWay />
        <Starfield />
        <Suspense fallback={null}>
          <Earth />
        </Suspense>
        <ShellRings />
        <ObjectField
          catalog={catalog}
          layers={layers}
          selected={selected?.norad ?? null}
          alerts={alerts}
          onSelect={onSelect}
          focus={focus?.roles ?? null}
          onFps={onFps}
        />
        {focus ? (
          // With a plan drawn, the full orbits recede so the red / green / grey paths read clearly.
          focus.orbits.map((o) => (
            <SelectedOrbit key={o.entry.norad} entry={o.entry} at={focus.at} color={o.color} glow={!focus.avoid} faint={!!focus.avoid} />
          ))
        ) : (
          <SelectedOrbit entry={selected} at={selectedAt} />
        )}
        {focus?.line && <ConjunctionLine a={focus.line[0]} b={focus.line[1]} />}
        {focus?.tcaPoint && <TcaMarker point={focus.tcaPoint} />}
        {focus?.avoid && <AvoidPaths a={focus.avoid} />}
        {launchSites && <LaunchSitePins {...launchSites} />}
        <CameraRig
          target={selected}
          targetAt={selectedAt}
          insets={insets}
          framing={framing}
          focusPoint={focus?.cameraPoint ?? flyTo}
          closeUp={focus?.closeUp ?? null}
        />
      </Canvas>
    </div>
  );
}
