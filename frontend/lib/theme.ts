import type { ObjectType } from "./api";

/** The only palette allowed by CLAUDE.md "Design specifics". */
export const PALETTE = {
  space: "#05060A",
  ivory: "#F2EBDD",
  muted: "#B8B2A7",
  gold: "#D9B77E",
  ice: "#A8C8E8",
  silver: "#CFC6B8",
  amber: "#C9A36A",
  rose: "#E0707A",
} as const;

/**
 * Avoidance paths on the globe (focus mode). Green is the one addition to the palette, asked for explicitly:
 * a calm sage, not neon. Red = alert rose. Grey = a cool neutral, recessive next to both.
 */
export const PATH_COLORS = {
  risk: PALETTE.rose,
  optimal: "#8FBF9A",
  other: "#8A877F",
} as const;

export const TYPE_COLORS: Record<ObjectType, string> = {
  payload: PALETTE.ice,
  rocket: PALETTE.amber,
  debris: PALETTE.silver,
  unknown: PALETTE.muted,
};

export const TYPE_LABELS: Record<ObjectType, string> = {
  payload: "Payloads",
  rocket: "Rocket bodies",
  debris: "Debris",
  unknown: "Unknown",
};

export const TYPE_SINGULAR: Record<ObjectType, string> = {
  payload: "Payload",
  rocket: "Rocket body",
  debris: "Debris",
  unknown: "Unknown",
};
