export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Official Space-Track OBJECT_TYPE values. */
export type OfficialType = "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN";

export interface CatalogEntry {
  norad: number;
  name: string;
  object_type: OfficialType;
  /** "space-track" = official type; "inferred" = guessed from name (CelesTrak fallback); "pasted" = user TLE. */
  type_source: "space-track" | "inferred" | "pasted";
  group: string;
  tle1: string;
  tle2: string;
  epoch: string;
  perigee_km: number;
  apogee_km: number;
  /** Space-Track radar cross-section class; null/absent = not provided ("unknown"). */
  rcs_size?: RcsSize | null;
}

export type RcsSize = "SMALL" | "MEDIUM" | "LARGE";

/** Space-Track RCS_SIZE bins: SMALL < 0.1 m², MEDIUM 0.1–1 m², LARGE > 1 m². */
export function rcsLabel(size: RcsSize | null | undefined): string {
  if (size === "SMALL") return "small (< 0.1 m²)";
  if (size === "MEDIUM") return "medium (0.1–1 m²)";
  if (size === "LARGE") return "large (> 1 m²)";
  return "unknown";
}

export type ObjectType = "payload" | "rocket" | "debris" | "unknown";
export const OBJECT_TYPES: ObjectType[] = ["payload", "rocket", "debris", "unknown"];

const FROM_OFFICIAL: Record<OfficialType, ObjectType> = {
  PAYLOAD: "payload",
  "ROCKET BODY": "rocket",
  DEBRIS: "debris",
  UNKNOWN: "unknown",
};

export function objectType(entry: CatalogEntry): ObjectType {
  return FROM_OFFICIAL[entry.object_type] ?? "unknown";
}

export interface CatalogStatus {
  objects: number;
  by_type: Record<OfficialType, number>;
  catalog: { source: string; fetched_utc: string; type_source: "official" | "inferred"; note: string | null };
  spacetrack_configured: boolean;
  n2yo_configured: boolean;
  default_observer: { lat: number; lon: number; alt_m: number; name: string };
}

export interface AboveSat {
  norad: number;
  name: string;
  object_type?: OfficialType;
  int_designator: string | null;
  launch_date: string | null;
  lat: number;
  lon: number;
  alt_km: number;
  el_deg?: number;
  az_deg?: number;
  az_compass?: string;
}

/** Computed locally with SGP4 from our catalog; N2YO only as an optional cross-check (null when unavailable). */
export interface AboveResponse {
  observer: { lat: number; lon: number; alt_m: number };
  radius_deg: number;
  count: number;
  satellites: AboveSat[];
  cached: boolean;
  source?: "local";
  computed_utc?: string;
  cross_check?: { source: "N2YO"; n2yo_count: number; in_both: number; only_n2yo: number; only_local: number } | null;
}

export interface VisualPass {
  /** Rise (elevation 0°). */
  start_utc: string;
  start_az_compass: string | null;
  max_utc: string;
  max_el: number;
  max_az_compass: string | null;
  /** Set (elevation 0°). */
  end_utc: string;
  end_az_compass: string | null;
  mag: number | null;
  /** Rise to set. */
  duration_s: number;
  /** Visible window: sunlit, ≥ 10° up, sun ≤ −6° at the observer (assumed rule, est.). */
  visible_start_utc?: string;
  visible_end_utc?: string;
  visible_s?: number;
}

export interface PassesResponse {
  norad: number;
  name: string | null;
  count: number;
  passes: VisualPass[];
  cached: boolean;
  source?: "local";
  /** Passes above the horizon in the window, visible or not. */
  horizon_passes?: number;
  /** The object never sets (e.g. geostationary), so it has no passes. */
  always_above_horizon?: boolean;
  method?: string;
  cross_check?: { source: "N2YO"; n2yo_count: number; matched: number; median_peak_diff_s: number | null } | null;
}

/** Error carrying the server's user-facing `detail` message. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Backend unreachable. Is the API running on port 8000?");
  }
  if (!res.ok) {
    let detail = `Request failed (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail)) detail = "Invalid input.";
    } catch {
      /* keep generic message */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const fetchCatalog = (signal?: AbortSignal) => getJson<CatalogEntry[]>("/catalog", signal);
export const fetchStatus = (signal?: AbortSignal) => getJson<CatalogStatus>("/status", signal);
export const fetchObject = (norad: number) => getJson<CatalogEntry>(`/object/${norad}`);

export function fetchAbove(lat: number, lon: number, radius: number, altM?: number) {
  const q = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(radius) });
  if (altM !== undefined) q.set("alt_m", String(Math.round(altM)));
  return getJson<AboveResponse>(`/above?${q}`);
}

export function fetchPasses(norad: number, lat: number, lon: number, altM?: number) {
  const q = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  if (altM !== undefined) q.set("alt_m", String(Math.round(altM)));
  return getJson<PassesResponse>(`/passes/${norad}?${q}`);
}

// --------------------------------------------------------------------------- risk (build steps 3-4)

export type RiskLevel = "alert" | "watch" | "low";

export interface Conjunction {
  norad: number;
  name: string;
  object_type: OfficialType;
  tca_utc: string;
  miss_km: number;
  vrel_kms: number;
  /** Combined 1-sigma, ASSUMED from TLE ages (TLEs carry no covariance). */
  sigma_km: number;
  pc: number;
  alert: boolean;
  level: RiskLevel;
  primary_norad: number;
  /** AI risk (model estimate): calibrated probability that the FINAL collision risk is >= 1e-6. */
  ai_p_high?: number;
  /** The model's estimate of the final log10 collision probability. */
  ai_log10_risk?: number;
  /** False when the conjunction is outside the 2-7 day lead the model was trained on. */
  ai_in_domain?: boolean;
  /** The live model's operating threshold on ai_p_high (validation, >= 95% recall). */
  ai_threshold?: number;
  /** AI probability now minus with that input group at its training median. */
  ai_contributions?: Record<string, number>;
  /** Separation at TCA in the protected asset's RTN frame (km). */
  radial_km?: number;
  in_track_km?: number;
  cross_track_km?: number;
  primary_tle_age_h?: number;
  secondary_tle_age_h?: number;
  primary_object_type?: OfficialType;
  primary_name?: string;
  /** Geodetic point midway between the two objects at TCA (WGS-84). */
  tca_lat_deg?: number;
  tca_lon_deg?: number;
  tca_alt_km?: number;
  primary_rcs_size?: RcsSize | null;
  secondary_rcs_size?: RcsSize | null;
  decision?: Decision;
  explanation?: Explanation;
}

export type DecisionCode = "GO" | "MONITOR" | "WATCH" | "NO-GO";

/** Go / No-Go recommendation (backend/decision.py). The operator decides; nothing is executed. */
export interface Decision {
  decision: DecisionCode;
  label: string;
  rank: number;
  headline: string;
  reasons: string[];
  /** GO before the avoidance planner has confirmed a valid option. */
  provisional: boolean;
  can_manoeuvre: boolean;
  recommended: {
    dv_ms: number;
    direction: string;
    direction_label: string;
    burn_utc: string;
    lead_h: number;
    new_pc: number;
    new_miss_km: number;
    propellant_kg?: number;
  } | null;
  recheck_before: { utc: string; basis: string; passed?: boolean } | null;
  hours_to_tca: number;
  /** Stage 1: AI P(high-risk) at or above the 95%-recall threshold. */
  ai_flag?: boolean;
  /** AI flag without physics confirmation: decision stays NO-GO, tagged "AI early flag". */
  early_flag?: boolean;
  /** Either TLE older than 3 days. */
  stale?: boolean;
  tags?: string[];
  note: string;
}

export interface ExplanationFactor {
  key: string;
  text: string;
  /** Signed change in AI probability (physical factors). */
  contribution?: number | null;
  /** 0-1 bar length; null when the model does not use this input. */
  bar: number | null;
  effect: "raises" | "lowers" | "neutral" | null;
  probability?: number;
  in_domain?: boolean;
}

export interface Explanation {
  factors: ExplanationFactor[];
  method: string;
}

export interface DecisionRules {
  config: Record<string, number | null>;
  stages?: { stage: number; title: string; when: string }[];
  rules: { decision: DecisionCode; label: string; when: string }[];
  deadline: string;
  ai_note: string;
  note: string;
}

export interface ScreenStats {
  primary_norad: number;
  primary_name: string;
  window_start_utc: string;
  horizon_h: number;
  screen_km: number;
  hbr_m: number;
  objects_in_catalog: number;
  pairs_after_altitude_filter: number;
  coarse_pair_epochs: number;
  refined_candidates: number;
  co_located_excluded: number;
  conjunctions: number;
  alerts: number;
  seconds: number;
  pairs_per_sec: number | null;
  pair_epochs_per_sec: number | null;
}

export interface ManeuverOption {
  lead_h: number;
  dv_ms: number | null;
  direction: "prograde" | "retrograde" | "none" | null;
  new_miss_km: number | null;
  new_pc: number | null;
  baseline_miss_km: number;
  baseline_pc: number;
  sigma_km: number;
  target_pc: number;
  feasible: boolean;
}

export interface ReentryItem {
  norad: number;
  name: string;
  object_type: OfficialType;
  perigee_km: number;
  apogee_km: number;
  /** Space-weather adjusted when the NOAA 27-day outlook is available (est.). */
  est_days: number;
  /** Mean-motion-derivative heuristic alone (est.). */
  est_days_raw?: number;
  sw_factor?: number | null;
  f107_recent?: number | null;
  f107_forecast_mean?: number | null;
  risk: "high" | "medium" | "low";
  tle_age_days: number;
  overdue: boolean;
  basis: string;
}

export interface SpaceWeather {
  f107: number;
  f107_time_utc: string;
  kp: number;
  kp_time_utc: string;
  ap: number | null;
  ap_basis: string;
  f107_27d_mean?: number | null;
  source: string;
  updated: string;
  stale: boolean;
  outlook?: { issued: string | null; source: string; stale: boolean; f107_mean: number | null; days: { date: string; f107: number; ap: number; kp_max: number }[] } | null;
}

export interface Metrics {
  objects_tracked: number;
  pairs_per_sec: number | null;
  median_tle_age_h: number | null;
  brier_score: number | null;
  last_screen: ScreenStats | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Backend unreachable. Is the API running on port 8000?");
  }
  if (!res.ok) {
    let detail = `Request failed (HTTP ${res.status}).`;
    try {
      const b = (await res.json()) as { detail?: unknown };
      if (typeof b.detail === "string") detail = b.detail;
      else if (Array.isArray(b.detail)) detail = "Invalid input.";
    } catch {
      /* keep generic message */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const screen = (req: { norad: number; horizon_h: number; screen_km: number; hbr_m: number }) =>
  postJson<Conjunction[]>("/screen", req);
export const planManeuver = (req: { norad: number; secondary: number; tca_utc: string }) =>
  postJson<ManeuverOption[]>("/maneuver", req);
export const fetchReentry = (limit = 12) => getJson<ReentryItem[]>(`/reentry?limit=${limit}`);
export const fetchSpaceWeather = () => getJson<SpaceWeather>("/spaceweather");
export const fetchMetrics = () => getJson<Metrics>("/metrics");
export const fetchDecisionRules = () => getJson<DecisionRules>("/decision/rules");

// --------------------------------------------------------------------------- AI risk model (build step 5)

export interface ScoreSet {
  n: number;
  n_high_risk: number;
  /** Share of high-risk events (the PR-AUC of a random ranking). */
  prevalence?: number;
  brier: number;
  /** Expected calibration error over fixed probability bins. */
  ece?: number;
  /** Area under the precision-recall curve (average precision). */
  pr_auc?: number | null;
  roc_auc: number | null;
  avg_precision: number | null;
  precision: number;
  recall: number;
  f1: number;
  f2: number;
  false_alert_rate: number;
  false_alerts_per_1000: number;
  alerts: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  mse_log_risk: number;
  /** Official Kelvins MSE on high-risk events, predictions clipped at -6. */
  mse_high_risk: number | null;
  mse_high_risk_unclipped: number | null;
  /** Official Kelvins loss L = MSE_HR / F2 (lower is better); null if undefined. */
  official_score: number | null;
}

export type ModelName = "baseline" | "full" | "live";
export type EvalSet = "holdout" | "official_test";
export type Interval = { lo: number | null; hi: number | null };

export interface CalibrationBin {
  bin: string;
  n: number;
  mean_predicted: number;
  observed_rate: number;
  positives: number;
}

export interface ImportanceRow {
  feature: string;
  importance: number;
  std: number;
}

export interface ModelMetrics {
  generated_utc: string;
  seed: number;
  dataset: {
    name: string;
    url: string;
    paper: string;
    years: string;
    description: string;
    train_events: number;
    train_events_eligible: number;
    train_high_risk_events: number;
    official_test_events: number;
    official_test_high_risk_events: number;
    note: string;
  };
  task: { target: string; inputs: string; high_risk: string; eligibility: string };
  split: {
    train_events: number;
    train_high_risk?: number;
    validation_events?: number;
    validation_high_risk?: number;
    holdout_events: number;
    holdout_high_risk: number;
    seed: number;
    rule?: string;
  };
  models: Record<ModelName, string>;
  thresholds: { full: number; live: number; rule?: string };
  hyperparameters?: Record<"full" | "live", Record<string, number | string | Record<string, number>>>;
  live_features?: string[];
  kpis?: Kpis;
  n_features: { full: number; live: number };
  feature_mapping: { feature: string; kelvins: string; live: string }[];
  results: Record<EvalSet, Record<ModelName, ScoreSet>>;
  intervals: Record<EvalSet, { vs_baseline: Record<"full" | "live", Record<string, Interval>> }>;
  calibration: Record<EvalSet, Record<"full" | "live", CalibrationBin[]>>;
  importance: Record<"full" | "live", ImportanceRow[]>;
  published: {
    latest_risk_baseline: { score: number; mse_hr: number; f2: number };
    winner_sesc: { score: number; mse_hr: number; f2: number };
    source: string;
  };
  verdict: Record<EvalSet, Record<"full" | "live", string[]>>;
  /** LSTM benchmark (`python ml.py lstm`); absent until it has been run. */
  model_comparison?: ModelComparison | null;
}

export type ComparisonModel =
  | "baseline"
  | "trees_full"
  | "trees_live"
  | "lstm_full"
  | "lstm_live"
  | "lstm_full_val_iso"
  | "lstm_live_val_iso";

export interface ComparisonRow {
  n: number;
  n_high_risk: number;
  brier: number;
  ece: number;
  pr_auc: number | null;
  roc_auc: number | null;
  /** At the model's own threshold chosen on validation for ≥ 95% recall. */
  recall: number;
  false_alert_rate: number;
  precision: number;
  alerts: number;
  tp: number;
  fn: number;
  fp: number;
  threshold: number;
}

export type ComparisonPair = "lstm_full_vs_trees_full" | "lstm_live_vs_trees_live";

export interface ModelComparison {
  generated_utc: string;
  /** generated_utc of the trees it was compared with (a later retrain makes this stale). */
  trees_trained_utc: string | null;
  versions: { torch: string };
  method: {
    split: string;
    lstm: string;
    calibration: string;
    selection: string;
    baseline: string;
    inputs: Record<"lstm_full" | "lstm_live", string>;
  };
  lstm: Record<"full" | "live", { weighting: string; pos_weight: number; epochs: number; hidden: number; inputs_per_cdm: number; parameters: number }>;
  results: Record<"validation" | EvalSet, Record<ComparisonModel, ComparisonRow>>;
  /** 95% bootstrap CI of LSTM − trees. */
  diff_ci: Record<EvalSet, Record<ComparisonPair, Record<"brier" | "pr_auc" | "false_alert_rate", Interval>>>;
  lstm_better_on_validation: Record<"full" | "live", boolean>;
  live_model: "trees" | "lstm";
  live_rule: string;
  reason: string;
  seconds: number;
}

export interface OperatingPoint {
  threshold: number;
  recall: number;
  target_recall: number;
  reached: boolean;
  false_alert_rate: number;
  alerts: number;
  n: number;
  n_high_risk: number;
}

type LeadCell = { recall: number; brier: number; false_alert_rate: number; pr_auc: number | null; tp: number; fn: number };
export interface LeadRow {
  days: number;
  label: string;
  n: number;
  n_high_risk: number;
  baseline: LeadCell;
  full: LeadCell;
  live: LeadCell;
}

type CalMetrics = { validation_brier: number; validation_ece: number };
type ImbalanceVariant = CalMetrics & {
  validation_pr_auc: number | null;
  threshold: number;
  validation_false_alert_rate: number;
} & Partial<Record<EvalSet, { brier: number; ece: number; pr_auc: number | null; recall: number; false_alert_rate: number }>>;

export interface Throughput {
  measured_utc: string;
  catalog_objects: number;
  catalog_source?: string;
  horizon_h: number;
  reference: { norad: number; name: string; seconds: number; pairs_after_altitude_filter: number; pairs_per_sec: number } | null;
  /** Whole Sentinel watchlist in one shared cKDTree pass. */
  watchlist?: { objects: number; seconds: number; seconds_per_object: number; conjunctions: number; pairs_checked: number };
  /** Older measurements only. */
  per_object_seconds?: { mean: number; median: number; min: number; max: number; n: number };
  pairs_per_sec_mean?: number;
  all_vs_all_estimate: { seconds: number; hours: number; unique_pairs: number; basis: string };
}

export interface Confusion {
  recall: number | null;
  false_alert_rate: number | null;
  precision: number | null;
  alerts: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export type DecisionLevel = "early_flag" | "watch_or_above" | "pc_watch_only" | "previous_rule";

export interface DecisionLevels {
  method: string;
  thresholds: Record<string, number>;
  levels: Record<DecisionLevel, string>;
  by_set: Record<
    EvalSet,
    Record<DecisionLevel, Confusion> & {
      n: number;
      n_high_risk: number;
      early_flag_only: number;
      go_from_ai_only: number;
      watch_or_above_by_trigger: { pc: number; ai_backed_by_pc: number; go_threshold: number };
    }
  >;
}

export interface Kpis {
  operating_point: { rule: string; target_recall: number; validation: Record<"full" | "live", OperatingPoint> };
  lead_time: { method: string; rows: Record<EvalSet, LeadRow[]> };
  class_imbalance: {
    before: string;
    tried: string;
    selection: string;
    by_feature_set: Record<string, { none: ImbalanceVariant; balanced: ImbalanceVariant; balanced_uncalibrated: CalMetrics; chosen: "none" | "balanced" }>;
  };
  radial_feature: {
    used: boolean;
    rule: string;
    by_set: Record<"live_base" | "live_radial", Record<string, Partial<ScoreSet> & { threshold?: number }>>;
  };
  throughput: Throughput | null;
  decision_levels?: DecisionLevels;
}

export const fetchModelMetrics = () => getJson<ModelMetrics>("/model/metrics");

/** Configured values the Model / About pages quote (GET /about, read from backend constants). */
export interface AboutConfig {
  screening: { coarse_step_s: number; refine_step_s: number; max_horizon_h: number; hbr_m_default: number };
  sigma: { base_km: number; per_day_km: number; assumed: boolean };
  avoidance: { mass_kg: number; isp_s: number; assumed: boolean; orbits_before: number[]; dv_min_ms: number; dv_max_ms: number };
  reentry: { max_perigee_km: number; f107_exponent: number; estimated: boolean };
  visibility: { min_elevation_deg: number; sun_max_elevation_deg: number; assumed: boolean };
  sentinel: { refresh_s: number; horizon_h: number; screen_km: number };
  refresh_s: Record<"spacetrack_gp" | "spacetrack_satcat" | "celestrak" | "swpc" | "swpc_outlook" | "n2yo_above" | "n2yo_passes", number>;
  ai: { min_tca_days: number; max_tca_days: number; high_risk_pc: number; calibration_folds: number; target_recall: number };
}

export const fetchAbout = () => getJson<AboutConfig>("/about");

/** 60 -> "60 s", 1800 -> "30 min", 3600 -> "1 h", 86400 -> "24 h". */
export function fmtDuration(s: number): string {
  if (s < 120) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${+(s / 3600).toFixed(1)} h`;
}

/** 1e-6 -> "1e−6" (typographic minus). */
export const fmtSci = (v: number | null | undefined) => (v == null ? "—" : v.toExponential(0).replace("e-", "e−").replace("e+0", ""));

// --------------------------------------------------------------------------- avoidance planning (CAM)

export type BurnDirection = "+T" | "-T" | "+R" | "-R" | "+N" | "-N";

export interface AvoidCandidate {
  id: string;
  direction: BurnDirection;
  direction_label: string;
  dv_ms: number;
  orbits_before: number;
  burn_utc: string;
  lead_h: number;
  new_miss_km: number;
  new_pc: number;
  new_tca_utc: string;
  meets_target: boolean;
  along_track_shift_km: number;
  total_shift_km: number;
  rule_3dvt_km: number;
  /** "not_checked" unless this option was re-screened against the catalog. */
  constraint: "passed" | "rejected" | "not_checked";
  new_conjunctions?: { norad: number; name: string; miss_km: number; pc: number; tca_utc: string }[];
  propellant_kg: number;
}

export interface AvoidBrief {
  norad: number;
  name: string;
  object_type: OfficialType;
  type_source?: string;
}

export interface AvoidPath {
  start_utc: string;
  step_s: number;
  original_km: [number, number, number][];
  burned_km: [number, number, number][];
  burn_point_km: [number, number, number];
  tca_original_km: [number, number, number];
  tca_burned_km: [number, number, number];
  other_at_tca_km: [number, number, number];
  /** Fields below are absent on plans stored before they existed. */
  other_km?: [number, number, number][];
  other_at_new_tca_km?: [number, number, number];
  dv_ms?: number;
  baseline_miss_km?: number | null;
  new_miss_km?: number;
  frame: string;
}

/** Avoidance burn + return-to-orbit burn (est., equal Δv), rocket equation. */
export interface BurnFuel {
  avoid_dv_ms: number;
  return_dv_ms: number;
  total_dv_ms: number;
  avoid_kg: number;
  return_kg: number;
  total_kg: number;
  tank_pct?: number;
  life_days?: number;
}

export interface FuelOption {
  id: string;
  direction: BurnDirection;
  direction_label: string;
  burn_utc: string;
  lead_h: number;
  orbits_before: number;
  dv_ms: number;
  avoid_kg: number;
  total_kg: number;
  pc_before: number | null;
  pc_after: number;
  new_miss_km: number;
  risk_reduction_per_g: number | null;
  recommended: boolean;
}

export interface AvoidFuel {
  recommended: BurnFuel | null;
  options: FuelOption[];
  assumptions: string[];
}

export interface LeadCurvePoint {
  lead_h: number;
  orbits_before: number;
  burn_utc: string;
  dv_ms: number;
  direction: BurnDirection;
  avoid_kg?: number;
  total_kg?: number;
}

export interface LeadCurve {
  points: LeadCurvePoint[];
  grid_points: { orbits_before: number; lead_h: number; dv_ms: number | null; direction?: BurnDirection; constraint?: AvoidCandidate["constraint"]; avoid_kg?: number | null }[];
  required_miss_km?: number | null;
  method?: string;
  note?: string;
  max_orbits?: number;
  period_min?: number;
  earliest_burn_utc?: string;
}

export interface AvoidResponse {
  possible: boolean;
  reason?: string;
  note?: string;
  primary: AvoidBrief;
  secondary: AvoidBrief;
  maneuvering?: AvoidBrief & { role: "primary" | "secondary" };
  other?: AvoidBrief;
  tca_utc?: string;
  baseline?: { miss_km: number; pc: number; sigma_km: number; vrel_kms: number };
  target_pc?: number;
  burn_times?: { orbits_before: number; burn_utc: string; lead_h: number; feasible: boolean; reason: string | null }[];
  candidates?: AvoidCandidate[];
  recommended?: (AvoidCandidate & { return_kg?: number; total_kg?: number }) | null;
  decision_deadline?: { burn_utc: string; lead_h: number; orbits_before: number; dv_ms: number; direction: BurnDirection; propellant_kg: number; total_kg?: number } | null;
  constraint?: {
    checked: number;
    passed: number;
    pairs_after_altitude_filter: number;
    co_located_excluded: number;
    window_start_utc: string;
    window_end_utc: string;
    existing_conjunctions: { norad: number; name: string; miss_km: number; pc: number }[];
  } | null;
  path?: AvoidPath | null;
  inputs?: {
    mass_kg: number;
    isp_s: number;
    mass_assumed: boolean;
    isp_assumed: boolean;
    tank_kg?: number;
    tank_assumed?: boolean;
    stationkeeping_ms_per_year?: number;
    stationkeeping_assumed?: boolean;
  };
  fuel?: AvoidFuel;
  lead_curve?: LeadCurve;
  assumptions: string[];
  timing_s?: { grid: number; constraint: number; total: number };
  cached?: boolean;
  /** Final recommendation for this conjunction, with the plan taken into account. */
  decision?: Decision;
  explanation?: Explanation;
}

export const planAvoidance = (req: {
  primary: number;
  secondary: number;
  tca: string;
  mass_kg?: number;
  isp_s?: number;
  target_pc?: number;
  tank_kg?: number;
  stationkeeping_ms_per_year?: number;
}) => postJson<AvoidResponse>("/avoid", req);

// --------------------------------------------------------------------------- launch fuel (first-order estimate)

export interface LaunchStage {
  stage: number;
  dv_kms: number;
  mass_ratio: number;
  propellant_kg: number;
  structure_kg: number;
  stage_mass_kg: number;
  mass_above_kg: number;
  ignition_mass_kg: number;
}

export interface LaunchBudget {
  ideal_kms: number;
  hohmann_reference_kms: number;
  losses_kms: number;
  reachable: boolean;
  rotation: { reachable: boolean; v_rot_kms: number; ratio: number; azimuth_deg?: number; azimuth_alt_deg?: number; bonus_kms?: number; reason?: string };
  rotation_bonus_kms?: number;
  total_kms?: number;
}

export interface LaunchResult {
  budget: LaunchBudget;
  feasible: boolean;
  reason?: string;
  mass_ratio?: number;
  stages?: LaunchStage[];
  gross_liftoff_kg?: number;
  propellant_total_kg?: number;
  structure_total_kg?: number;
  propellant_per_kg_payload?: number;
  payload_fraction_pct?: number;
}

export interface LaunchSite {
  key: string;
  name: string;
  short_name: string;
  country: string;
  status: LaunchSiteStatus;
  indian: boolean;
  lat_deg: number;
  min_inclination_deg: number;
  /** 1-based; equal values share a rank (tied). null = cannot reach the inclination directly / infeasible. */
  rank: number | null;
  tied: boolean;
  reachable: boolean;
  feasible: boolean;
  total_dv_kms: number | null;
  rotation_bonus_kms: number | null;
  propellant_per_kg_payload: number | null;
  gross_liftoff_kg: number | null;
  reason: string | null;
  due_east: { inclination_deg: number; total_dv_kms: number; rotation_bonus_kms: number; propellant_per_kg_payload: number | null };
}

export interface LaunchFuelResponse {
  inputs: {
    site: string;
    site_name: string;
    lat_deg: number;
    altitude_km: number;
    inclination_deg: number;
    payload_kg: number;
    propellant: string;
    propellant_name: string;
    isp_s: number;
    isp_assumed: boolean;
    stages: number;
    structural_fraction: number;
    losses_kms: number;
  };
  result: LaunchResult;
  sites: LaunchSite[];
  altitude_sweep: { altitude_km: number; total_dv_kms: number | null; propellant_per_kg_payload: number | null }[];
  constants: { mu_km3_s2: number; re_km: number; v_rot_equator_kms: number; g0_ms2: number };
  assumptions: string[];
}

export interface LaunchPresets {
  sites: Record<string, { name: string; short_name: string; lat_deg: number; lon_deg: number; country: string; status: LaunchSiteStatus; indian: boolean }>;
  site_aliases?: Record<string, string>;
  propellants: Record<string, { name: string; isp_s: number }>;
  defaults: { site: string; altitude_km: number; inclination_deg: number; payload_kg: number; propellant: string; stages: number; structural_fraction: number; losses_kms: number };
  assumptions: string[];
}

export interface LaunchFuelRequest {
  site?: string | null;
  lat_deg?: number | null;
  altitude_km: number;
  inclination_deg: number;
  payload_kg: number;
  propellant?: string | null;
  isp_s?: number | null;
  stages: number;
  structural_fraction: number;
  losses_kms: number;
}

// --------------------------------------------------------------------------- launch sites (verified dataset)

export type LaunchSiteStatus = "operational" | "under construction" | "inactive";

export interface LaunchSiteRecord {
  id: string;
  name: string;
  short_name: string;
  aliases: string[];
  country: string;
  operator: string | null;
  lat: number;
  lon: number;
  coord_approx: boolean;
  coord_note: string;
  coord_check: { method: string; distance_km: number };
  status: LaunchSiteStatus;
  launch_pads: string | null;
  rockets: string[];
  first_orbital_launch_year: number | null;
  first_orbital_note: string | null;
  notable_missions: string[];
  why: string | null;
  source_url: string;
  sources: string[];
  official_url: string | null;
  indian: boolean;
  physics: { v_rot_kms: number; min_inclination_deg: number; max_inclination_deg: number };
}

export interface LaunchSitesResponse {
  sites: LaunchSiteRecord[];
  count: number;
  countries: string[];
  statuses: LaunchSiteStatus[];
  compiled_utc: string;
  note: string;
  physics_note: string;
}

export const fetchLaunchSites = () => getJson<LaunchSitesResponse>("/launch-sites");

export const fetchLaunchPresets = () => getJson<LaunchPresets>("/launch-fuel/presets");
export const computeLaunchFuel = (req: LaunchFuelRequest) => postJson<LaunchFuelResponse>("/launch-fuel", req);

// --------------------------------------------------------------------------- Sentinel (continuous monitor)

export type Tier = "Crewed" | "Critical" | "Standard";
export type SentinelStatusCode = "NEW" | "WATCH" | "CONFIRMED GO" | "RESOLVED";

export interface CostOfActing {
  available: boolean;
  reason?: string;
  dv_ms?: number;
  direction?: string;
  direction_label?: string;
  propellant_kg?: number;
  burn_utc?: string;
  lead_h?: number;
  new_pc?: number;
  new_miss_km?: number;
  mass_assumed?: boolean;
  maneuvering?: string;
  /** Avoid + return-to-orbit (est., equal Δv); absent on plans stored before these existed. */
  total_dv_ms?: number | null;
  return_kg?: number | null;
  total_kg?: number | null;
  tank_pct?: number | null;
  life_days?: number | null;
}

export interface SentinelAlert {
  id: string;
  primary_norad: number;
  primary_name: string;
  tier: Tier;
  secondary_norad: number;
  secondary_name: string;
  secondary_type: OfficialType;
  tca_utc: string;
  hours_to_tca: number;
  miss_km: number;
  pc: number;
  ai_p_high: number | null;
  ai_log10_risk: number | null;
  decision: DecisionCode;
  status: SentinelStatusCode;
  status_reason: string;
  stale: boolean;
  early_flag: boolean;
  lower_confidence: boolean;
  consec_go: number;
  updates: number;
  first_seen: string;
  last_updated: string;
  resolved_utc: string | null;
  dv_ms: number | null;
  propellant_kg: number | null;
  burn_utc: string | null;
  cost_of_acting: CostOfActing;
  risk_of_not_acting: { pc: number; ai_final_risk: number | null; ai_p_high: number | null; ai_in_domain?: boolean | null };
}

export interface HistoryPoint {
  t_utc: string;
  pc: number;
  ai_p_high: number | null;
  ai_log10_risk: number | null;
  miss_km: number;
  decision: DecisionCode;
  status: SentinelStatusCode;
  data_update: number;
}

export interface SentinelAlertDetail extends SentinelAlert {
  record: Conjunction;
  decision_detail: Decision;
  explanation: Explanation | null;
  plan: (Partial<AvoidResponse> & { error?: string }) | null;
  history: HistoryPoint[];
}

export interface SentinelRun {
  started_utc: string;
  finished_utc: string;
  trigger: string;
  catalog_source: string | null;
  catalog_fetched_utc: string | null;
  objects_watched: number | null;
  pairs_checked: number | null;
  conjunctions: number | null;
  tracked: number | null;
  plans: number | null;
  seconds: number | null;
  screen_seconds: number | null;
  error: string | null;
  decisions?: Record<DecisionCode, number> | null;
  early_flagged?: number | null;
  missing?: number[] | null;
}

export interface SentinelStatus {
  running: boolean;
  busy: boolean;
  phase: string | null;
  last_run: SentinelRun | null;
  next_refresh_utc: string | null;
  refresh_s: number;
  horizon_h: number;
  screen_km: number;
  lower_confidence_after_h: number;
  alerts_by_status: Partial<Record<SentinelStatusCode, number>>;
  objects_watched: number;
  telegram_configured: boolean;
  note: string;
}

export interface WatchItem {
  norad: number;
  name: string;
  tier: Tier;
  source: string;
  note: string | null;
  enabled: number;
  added_utc: string;
  in_catalog: boolean;
  object_type: OfficialType | null;
  perigee_km: number | null;
  apogee_km: number | null;
}

export interface WatchlistResponse {
  tiers: Tier[];
  items: WatchItem[];
  sync: Record<string, unknown>;
}

export interface ReplayPoint {
  step: number;
  time_to_tca_d: number;
  pc: number;
  ai_p_high: number | null;
  ai_log10_risk: number | null;
  miss_km: number;
  decision: DecisionCode;
  status: SentinelStatusCode;
  reason: string;
  early_flag: boolean;
}

export interface ReplayState {
  active: boolean;
  finished?: boolean;
  banner?: string;
  event_id?: number;
  mission_id?: string;
  primary_name?: string;
  secondary_type?: OfficialType;
  total?: number;
  step?: number;
  step_s?: number;
  cdms?: ReplayPoint[];
  current?: { record: Conjunction & { time_to_tca_d: number }; decision: Decision; explanation: Explanation; guard: { status: SentinelStatusCode; reason: string; consec_go: number } } | null;
  final?: { risk_log10: number | null; pc: number | null; time_to_tca_d: number | null; miss_km: number | null; high_risk: boolean; note: string } | null;
  avoidance?: string;
  fuel?: string;
  source?: string;
}

async function sendJson<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Backend unreachable. Is the API running on port 8000?");
  }
  if (!res.ok) {
    let detail = `Request failed (HTTP ${res.status}).`;
    try {
      const b = (await res.json()) as { detail?: unknown };
      if (typeof b.detail === "string") detail = b.detail;
    } catch {
      /* keep generic message */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const fetchSentinelStatus = () => getJson<SentinelStatus>("/sentinel/status");
export const fetchSentinelAlerts = () => getJson<SentinelAlert[]>("/sentinel/alerts");
export const fetchSentinelAlert = (id: string) => getJson<SentinelAlertDetail>(`/sentinel/alerts/${encodeURIComponent(id)}`);
export const runSentinel = () => sendJson<{ started: boolean }>("POST", "/sentinel/run");
export const fetchWatchlist = () => getJson<WatchlistResponse>("/sentinel/watchlist");
export const addToWatchlist = (norad: number, tier: Tier = "Standard") => sendJson<WatchItem>("POST", "/sentinel/watchlist", { norad, tier });
export const setWatchTier = (norad: number, tier: Tier) => sendJson<WatchItem>("PATCH", `/sentinel/watchlist/${norad}`, { tier });
export const removeFromWatchlist = (norad: number) => sendJson<{ removed: number }>("DELETE", `/sentinel/watchlist/${norad}`);
export const startReplay = () => sendJson<ReplayState>("POST", "/sentinel/replay", {});
export const stopReplay = () => sendJson<ReplayState>("DELETE", "/sentinel/replay");
export const fetchReplay = () => getJson<ReplayState>("/sentinel/replay");
export const SENTINEL_STREAM_URL = `${API_URL}/sentinel/stream`;
