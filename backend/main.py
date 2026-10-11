"""KesslerWatch API."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse

from pydantic import BaseModel, Field

import decision
import launch_fuel
import maneuver_opt
import ml
import orbit
import risk
import sentinel
import watchlist

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Build the catalog in the background so the first page load doesn't wait on a cold download.
    threading.Thread(target=get_catalog, daemon=True).start()
    # Sentinel: hourly watchlist screening in a background thread (SENTINEL_DISABLED=1 turns it off).
    if os.environ.get("SENTINEL_DISABLED") != "1":
        sentinel.SENTINEL.start(sentinel.Hooks(refresh_catalog=refresh_catalog, get_index=get_index))
    yield
    sentinel.SENTINEL.stop()
    sentinel.REPLAY.stop()


app = FastAPI(title="KesslerWatch", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# The full catalog is several MB of JSON; gzip cuts it to roughly a third.
app.add_middleware(GZipMiddleware, minimum_size=2048)

# Default observer: Hubballi (Hubli), Karnataka. Elevation ~627 m (GeoNames via Open-Meteo).
DEFAULT_NAME = "Hubballi"
DEFAULT_LAT = 15.3647
DEFAULT_LON = 75.1240
DEFAULT_ALT_M = 627.0
MAX_SCREEN_HORIZON_H = 72.0  # /screen window cap (h)
CATALOG_TTL_S = 2 * 3600  # rebuild from the (separately cached) sources at most this often

_catalog: list[dict] = []
_by_norad: dict[int, dict] = {}
_meta: dict = {}
_built_at = 0.0
_lock = threading.Lock()
_index: risk.CatalogIndex | None = None
_index_built_at = -1.0
_index_lock = threading.Lock()
_last_screen: dict | None = None


def get_catalog() -> tuple[list[dict], dict]:
    global _catalog, _by_norad, _meta, _built_at
    with _lock:
        if not _catalog or time.time() - _built_at > CATALOG_TTL_S:
            t0 = time.time()
            _catalog, _meta = orbit.build_catalog()
            _by_norad = {e["norad"]: e for e in _catalog}
            _built_at = time.time()
            logging.getLogger("kesslerwatch").info(
                "catalog: %d objects from %s in %.1f s", len(_catalog), _meta.get("source"), time.time() - t0
            )
        return _catalog, _meta


def refresh_catalog() -> tuple[list[dict], dict, dict[int, dict]]:
    """Rebuild now (Sentinel, once per cycle). Space-Track is only queried if its cache is over an hour old."""
    global _catalog, _by_norad, _meta, _built_at
    with _lock:
        t0 = time.time()
        _catalog, _meta = orbit.build_catalog()
        _by_norad = {e["norad"]: e for e in _catalog}
        _built_at = time.time()
        logging.getLogger("kesslerwatch").info("catalog refresh: %d objects from %s in %.1f s", len(_catalog), _meta.get("source"), time.time() - t0)
        return _catalog, _meta, _by_norad


def get_index() -> risk.CatalogIndex:
    """Parsed satrecs for screening, rebuilt only when the catalog is rebuilt."""
    global _index, _index_built_at
    get_catalog()
    with _index_lock:
        if _index is None or _index_built_at != _built_at:
            _index = risk.build_index(_catalog)
            _index_built_at = _built_at
        return _index


def resolve_object(norad: int) -> dict:
    """Catalog entry for any NORAD ID (catalog first, then on-demand lookup)."""
    get_catalog()
    if norad in _by_norad:
        return _by_norad[norad]
    try:
        return orbit.lookup_object(norad)
    except orbit.Decayed as d:
        raise HTTPException(410, f"NORAD {norad} re-entered (decay date {d.decay_date}); no current orbit.") from None
    except orbit.NotFound:
        raise HTTPException(404, f"No element set found for NORAD {norad}.") from None
    except orbit.SourceError as e:
        raise HTTPException(502, f"Lookup failed: {e}") from None


@app.get("/catalog")
def catalog() -> list[dict]:
    return get_catalog()[0]


@app.get("/status")
def status() -> dict:
    """Catalog provenance and which optional integrations are configured (never the secrets)."""
    entries, meta = get_catalog()
    counts: dict[str, int] = {t: 0 for t in orbit.OBJECT_TYPES}
    for e in entries:
        counts[e["object_type"]] += 1
    return {
        "objects": len(entries),
        "by_type": counts,
        "catalog": meta,
        "spacetrack_configured": orbit.spacetrack_configured(),
        "n2yo_configured": orbit.n2yo_configured(),
        "default_observer": {"lat": DEFAULT_LAT, "lon": DEFAULT_LON, "alt_m": DEFAULT_ALT_M, "name": DEFAULT_NAME},
    }


@app.get("/object/{norad}")
def object_by_norad(norad: int) -> dict:
    if not 0 < norad < 1_000_000:
        raise HTTPException(422, "NORAD ID must be a positive integer.")
    return resolve_object(norad)


class ScreenRequest(BaseModel):
    norad: int = Field(gt=0)
    horizon_h: float = Field(24, gt=0, le=MAX_SCREEN_HORIZON_H)
    screen_km: float = Field(10, gt=0, le=50)
    hbr_m: float = Field(20, gt=0, le=500)


@app.post("/screen")
def screen(req: ScreenRequest) -> list[dict]:
    """Conjunctions of one asset against the full catalog (see risk.screen and CLAUDE.md physics rules)."""
    global _last_screen
    primary = resolve_object(req.norad)
    try:
        results, stats = risk.screen(get_index(), primary, req.horizon_h, req.screen_km, req.hbr_m)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    # AI risk: the live model's estimate of the FINAL risk, from ESA CDM data (a model estimate, see ml.py).
    try:
        ml.score_conjunctions(results, datetime.fromisoformat(stats["window_start_utc"].replace("Z", "+00:00")))
    except Exception:  # never let the optional model break screening
        logging.getLogger("kesslerwatch").exception("AI risk scoring failed")
    # Go / No-Go recommendation + explanation per alert, sorted GO, MONITOR, WATCH, NO-GO, then Pc.
    # A GO here is provisional until /avoid confirms a valid option (that plan takes ~20 s per conjunction).
    get_catalog()
    movers = {primary["norad"]: primary, **{c["norad"]: _by_norad[c["norad"]] for c in results if c["norad"] in _by_norad}}
    decision.annotate(results, datetime.now(timezone.utc), {n: decision.period_from_tle(e["tle2"]) for n, e in movers.items()})
    stats["decisions"] = {d: sum(1 for c in results if c["decision"]["decision"] == d) for d in decision.RANK}
    _last_screen = {**stats, "primary_name": primary["name"]}
    logging.getLogger("kesslerwatch").info(
        "screen %s: %d conjunctions, %d alerts, %.1f s, %s pairs/s",
        primary["name"], stats["conjunctions"], stats["alerts"], stats["seconds"], stats["pairs_per_sec"],
    )
    return results


class ManeuverRequest(BaseModel):
    norad: int = Field(gt=0)
    secondary: int = Field(gt=0)
    tca_utc: datetime
    hbr_m: float = Field(20, gt=0, le=500)


@app.post("/maneuver")
def maneuver(req: ManeuverRequest) -> list[dict]:
    """Along-track burn options (Δs ≈ 3·Δv·Δt) that bring Pc below the target. Estimates."""
    tca = req.tca_utc if req.tca_utc.tzinfo else req.tca_utc.replace(tzinfo=timezone.utc)
    try:
        return risk.maneuver(resolve_object(req.norad), resolve_object(req.secondary), tca.astimezone(timezone.utc), req.hbr_m)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


class AvoidRequest(BaseModel):
    primary: int = Field(gt=0, description="Protected asset (NORAD ID)")
    secondary: int = Field(gt=0, description="The other object (NORAD ID)")
    tca: datetime = Field(description="Time of closest approach, UTC (from /screen)")
    mass_kg: float | None = Field(None, gt=0, le=1_000_000, description="Spacecraft wet mass; default 500 kg (assumed)")
    isp_s: float | None = Field(None, gt=0, le=10_000, description="Specific impulse; default 220 s (hydrazine, assumed)")
    target_pc: float = Field(maneuver_opt.DEFAULT_TARGET_PC, gt=0, lt=1)
    hbr_m: float = Field(20, gt=0, le=500)
    tank_kg: float | None = Field(None, gt=0, le=1_000_000, description="Propellant tank capacity; default 10 % of mass (assumed)")
    stationkeeping_ms_per_year: float | None = Field(None, gt=0, le=1000, description="Yearly station-keeping Δv; default 10 m/s (assumed)")


@app.post("/avoid")
def avoid(req: AvoidRequest) -> dict:
    """Collision-avoidance manoeuvre plan for the payload in this conjunction (see maneuver_opt.py). Estimates."""
    tca = req.tca if req.tca.tzinfo else req.tca.replace(tzinfo=timezone.utc)
    try:
        return decision.assess(
            get_index(), resolve_object(req.primary), resolve_object(req.secondary), tca.astimezone(timezone.utc),
            mass_kg=req.mass_kg, isp_s=req.isp_s, target_pc=req.target_pc, hbr_m=req.hbr_m,
            tank_kg=req.tank_kg, sk_ms_per_year=req.stationkeeping_ms_per_year,
        )
    except (ValueError, RuntimeError) as e:
        raise HTTPException(422, str(e)) from None


class LaunchFuelRequest(BaseModel):
    site: str | None = Field("sdsc", description="Launch-site id from GET /launch-sites (e.g. sdsc, kourou, ccsfs, baikonur); ignored if lat_deg is given")
    lat_deg: float | None = Field(None, gt=-90, lt=90, description="Custom launch latitude")
    altitude_km: float = Field(500, ge=100, le=40000)
    inclination_deg: float = Field(97.4, ge=0, le=180)
    payload_kg: float = Field(1000, gt=0, le=1_000_000)
    propellant: str | None = Field("kerolox", description="Preset (solid, kerolox, hydrolox); ignored if isp_s is given")
    isp_s: float | None = Field(None, ge=50, le=1000)
    stages: int = Field(2, ge=1, le=4)
    structural_fraction: float = Field(0.08, gt=0, lt=1)
    losses_kms: float = Field(1.5, ge=0, le=5)


@app.post("/launch-fuel")
def launch_fuel_endpoint(req: LaunchFuelRequest) -> dict:
    """Propellant to launch a payload into a circular orbit (first-order estimate; see launch_fuel.py)."""
    try:
        return launch_fuel.launch_fuel(site=req.site, lat_deg=req.lat_deg, altitude_km=req.altitude_km, inclination_deg=req.inclination_deg,
                                       payload_kg=req.payload_kg, propellant=req.propellant, isp_s=req.isp_s, stages_n=req.stages,
                                       structural_fraction=req.structural_fraction, losses_kms=req.losses_kms)
    except launch_fuel.LaunchInputError as e:
        raise HTTPException(422, str(e)) from None


@app.get("/launch-fuel/presets")
def launch_fuel_presets() -> dict:
    return launch_fuel.presets()


@app.get("/launch-sites")
def launch_sites() -> dict:
    """Orbital launch sites (verified dataset, backend/data_static/launch_sites.json) with Earth-rotation facts."""
    return launch_fuel.site_list()


@app.get("/decision/rules")
def decision_rules() -> dict:
    """Thresholds and rules behind the Go / No-Go recommendation (shown in the UI under "Decision rules")."""
    return decision.rules()


@app.get("/reentry")
def reentry(limit: int = Query(25, ge=1, le=200)) -> list[dict]:
    """Objects likely to re-enter soon. HEURISTIC from the mean-motion derivative, scaled by the NOAA SWPC 27-day
    F10.7 outlook when available; every value is est."""
    return risk.reentry(get_catalog()[0], limit=limit, solar=_solar())


def _solar() -> dict | None:
    """Observed 27-day mean F10.7 + the 27-day outlook, for the re-entry scaling (None if either is unavailable)."""
    try:
        sw = orbit.space_weather()
        ol = orbit.solar_outlook()
    except orbit.SourceError:
        return None
    recent = sw.get("f107_27d_mean") or sw.get("f107")
    return {"f107_recent": recent, "days": ol["days"]} if recent and ol.get("days") else None


@app.get("/spaceweather")
def spaceweather() -> dict:
    try:
        sw = orbit.space_weather()
    except orbit.SourceError as e:
        raise HTTPException(502, str(e)) from None
    try:
        ol = orbit.solar_outlook()
        today = datetime.now(timezone.utc).date().isoformat()
        ahead = [d for d in ol["days"] if d["date"] >= today]
        sw = {**sw, "outlook": {"issued": ol.get("issued"), "source": ol.get("source"), "stale": ol.get("stale"),
                                "f107_mean": round(sum(d["f107"] for d in ahead) / len(ahead), 1) if ahead else None,
                                "days": ahead}}
    except orbit.SourceError:
        sw = {**sw, "outlook": None}
    return sw


@app.get("/about")
def about() -> dict:
    """The configured values the Model / About pages quote, read from the backend constants (so the UI never drifts)."""
    return {
        "screening": {"coarse_step_s": risk.COARSE_STEP_S, "refine_step_s": risk.REFINE_STEP_S, "max_horizon_h": MAX_SCREEN_HORIZON_H,
                      "hbr_m_default": ScreenRequest.model_fields["hbr_m"].default},
        "sigma": {"base_km": risk.SIGMA_BASE_KM, "per_day_km": risk.SIGMA_PER_DAY_KM, "assumed": True},
        "avoidance": {"mass_kg": maneuver_opt.DEFAULT_MASS_KG, "isp_s": maneuver_opt.DEFAULT_ISP_S, "assumed": True,
                      "tank_fraction": maneuver_opt.DEFAULT_TANK_FRACTION, "stationkeeping_ms_per_year": maneuver_opt.DEFAULT_SK_MS_PER_YEAR,
                      "lead_curve_max_orbits": maneuver_opt.LEAD_CURVE_MAX_ORBITS,
                      "orbits_before": list(maneuver_opt.ORBITS_BEFORE),
                      "dv_min_ms": round(float(maneuver_opt.DV_GRID_MS[0]), 6), "dv_max_ms": round(float(maneuver_opt.DV_GRID_MS[-1]), 6)},
        "reentry": {"max_perigee_km": risk.REENTRY_MAX_PERIGEE_KM, "f107_exponent": risk.SW_DENSITY_EXPONENT, "estimated": True},
        "visibility": {"min_elevation_deg": orbit.VIS_MIN_EL_DEG, "sun_max_elevation_deg": orbit.SUN_DARK_DEG, "assumed": True},
        "sentinel": {"refresh_s": sentinel.REFRESH_S, "horizon_h": sentinel.HORIZON_H, "screen_km": sentinel.SCREEN_KM},
        "refresh_s": {"spacetrack_gp": orbit.ST_REFRESH_S, "spacetrack_satcat": orbit.SATCAT_TTL_S, "celestrak": orbit.CELESTRAK_TTL_S,
                      "swpc": orbit.SW_TTL_S, "swpc_outlook": orbit.OUTLOOK_TTL_S,
                      "n2yo_above": orbit.N2YO_ABOVE_TTL_S, "n2yo_passes": orbit.N2YO_PASSES_TTL_S},
        "ai": {"min_tca_days": ml.MIN_TCA_DAYS, "max_tca_days": ml.MAX_TCA_DAYS, "high_risk_pc": 10.0 ** ml.HIGH_RISK,
               "calibration_folds": ml.CAL_FOLDS, "target_recall": ml.TARGET_RECALL},
    }


@app.get("/model/metrics")
def model_metrics() -> dict:
    """Training/evaluation report of the AI risk model (baseline vs full vs live), written by `python ml.py train`."""
    m = ml.model_metrics()
    if m is None:
        raise HTTPException(404, "The AI risk model has not been trained yet. Run `python ml.py train` in backend/.")
    return m


@app.get("/metrics")
def metrics() -> dict:
    entries, _ = get_catalog()
    now = datetime.now(timezone.utc)
    ages = [(now - datetime.fromisoformat(e["epoch"].replace("Z", "+00:00"))).total_seconds() / 3600 for e in entries]
    return {
        "objects_tracked": len(entries),
        "pairs_per_sec": _last_screen["pairs_per_sec"] if _last_screen else None,
        "median_tle_age_h": round(statistics.median(ages), 1) if ages else None,
        # Full model, calibrated high-risk probability, on the held-out events (see /model/metrics).
        "brier_score": (ml.model_metrics() or {}).get("results", {}).get("holdout", {}).get("full", {}).get("brier"),
        "last_screen": _last_screen,
    }


# "Above me" and "Visible passes" are computed locally with SGP4 from our catalog (orbit.local_above/local_passes).
# N2YO is only an optional cross-check: used when its key works and it answers within a few seconds; any failure is
# silent (users never see an N2YO error). It runs in a worker thread so a slow N2YO never delays the local answer much.
N2YO_XCHECK_WAIT_S = 4.0
_xcheck_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="n2yo-xcheck")


def _n2yo_cross_check(fn, *args) -> dict | None:
    if not orbit.n2yo_configured():
        return None
    try:
        return _xcheck_pool.submit(fn, *args).result(timeout=N2YO_XCHECK_WAIT_S)
    except Exception as e:  # N2YOError, timeout, anything: fall back to local results only
        # Type name only: N2YO messages are sanitized, but the key travels in the URL, so never log more.
        logging.getLogger("kesslerwatch").info("N2YO cross-check skipped (%s)", type(e).__name__)
        return None


@app.get("/above")
def above(
    lat: float = Query(DEFAULT_LAT, ge=-90, le=90),
    lon: float = Query(DEFAULT_LON, ge=-180, le=180),
    radius: int = Query(70, ge=0, le=90, description="Search radius in degrees from the zenith (0-90): elevation >= 90 - radius"),
    alt_m: float = Query(DEFAULT_ALT_M, ge=-500, le=9000),
) -> dict:
    """Catalog objects currently above an observer, computed locally (SGP4); optional N2YO cross-check."""
    index = get_index()
    data = orbit.local_above(index.entries, index.satrecs, lat, lon, alt_m, radius)
    x = _n2yo_cross_check(orbit.n2yo_above, lat, lon, alt_m, radius)
    if x is not None:
        theirs, ours = {s["norad"] for s in x["satellites"]}, {s["norad"] for s in data["satellites"]}
        data = {**data, "cross_check": {"source": "N2YO", "n2yo_count": len(theirs), "in_both": len(theirs & ours),
                                        "only_n2yo": len(theirs - ours), "only_local": len(ours - theirs)}}
    return {"observer": {"lat": lat, "lon": lon, "alt_m": alt_m}, "radius_deg": radius, "cross_check": None, **data}


PASS_MATCH_S = 300  # a local and an N2YO pass are "the same" if their peak times are within 5 min


@app.get("/passes/{norad}")
def passes(
    norad: int,
    lat: float = Query(DEFAULT_LAT, ge=-90, le=90),
    lon: float = Query(DEFAULT_LON, ge=-180, le=180),
    alt_m: float = Query(DEFAULT_ALT_M, ge=-500, le=9000),
    days: int = Query(10, ge=1, le=10),
    min_visibility: int = Query(60, ge=1, le=600, description="Minimum optically visible seconds"),
) -> dict:
    """Upcoming visible passes over an observer, computed locally (SGP4); optional N2YO cross-check."""
    data = orbit.local_passes(resolve_object(norad), lat, lon, alt_m, days, min_visibility)
    x = _n2yo_cross_check(orbit.n2yo_passes, norad, lat, lon, alt_m, days, min_visibility)
    if x is not None:
        ours = [datetime.fromisoformat(p["max_utc"].replace("Z", "+00:00")) for p in data["passes"]]
        diffs = []
        for p in x["passes"]:
            if not p.get("max_utc"):
                continue
            t = datetime.fromisoformat(p["max_utc"].replace("Z", "+00:00"))
            best = min((abs((t - o).total_seconds()) for o in ours), default=None)
            if best is not None and best <= PASS_MATCH_S:
                diffs.append(best)
        data = {**data, "cross_check": {"source": "N2YO", "n2yo_count": x["count"], "matched": len(diffs),
                                        "median_peak_diff_s": round(statistics.median(diffs)) if diffs else None}}
    return {"observer": {"lat": lat, "lon": lon, "alt_m": alt_m}, "cross_check": None, **data}


# --------------------------------------------------------------------------- Sentinel


@app.get("/sentinel/status")
def sentinel_status() -> dict:
    return sentinel.SENTINEL.status()


@app.get("/sentinel/alerts")
def sentinel_alerts(include_resolved: bool = True) -> list[dict]:
    """Alert board, sorted by status (CONFIRMED GO, WATCH, NEW, RESOLVED) then Pc."""
    return sentinel.SENTINEL.alerts(include_resolved)


@app.get("/sentinel/alerts/{alert_id}")
def sentinel_alert(alert_id: str) -> dict:
    a = sentinel.SENTINEL.alert(alert_id)
    if a is None:
        raise HTTPException(404, "No such alert.")
    return a


@app.post("/sentinel/run", status_code=202)
def sentinel_run() -> dict:
    """Start a cycle now (the catalog still comes from cache unless it is over an hour old)."""
    if not sentinel.SENTINEL.trigger():
        raise HTTPException(409, "Sentinel is already running a cycle.")
    return {"started": True}


@app.get("/sentinel/watchlist")
def sentinel_watchlist() -> dict:
    get_catalog()
    items = []
    for it in watchlist.items():
        e = _by_norad.get(it["norad"])
        items.append({**it, "in_catalog": e is not None, "object_type": e["object_type"] if e else None,
                      "perigee_km": e["perigee_km"] if e else None, "apogee_km": e["apogee_km"] if e else None})
    return {"tiers": list(watchlist.TIERS), "items": items, "sync": watchlist.sync_info()}


class WatchAdd(BaseModel):
    norad: int = Field(gt=0, lt=1_000_000)
    tier: Literal["Crewed", "Critical", "Standard"] = "Standard"


@app.post("/sentinel/watchlist")
def sentinel_watch_add(req: WatchAdd) -> dict:
    e = resolve_object(req.norad)
    return watchlist.add(e["norad"], e["name"], req.tier)


class WatchTier(BaseModel):
    tier: Literal["Crewed", "Critical", "Standard"]


@app.patch("/sentinel/watchlist/{norad}")
def sentinel_watch_tier(norad: int, req: WatchTier) -> dict:
    r = watchlist.set_tier(norad, req.tier)
    if r is None:
        raise HTTPException(404, "Not on the watchlist.")
    return r


@app.delete("/sentinel/watchlist/{norad}")
def sentinel_watch_remove(norad: int) -> dict:
    if not watchlist.remove(norad):
        raise HTTPException(404, "Not on the watchlist.")
    return {"removed": norad}


SSE_STREAM_MAX_S = 25.0  # each stream ends after this; EventSource reconnects with Last-Event-ID (nothing is lost)


@app.get("/sentinel/stream")
async def sentinel_stream(request: Request) -> StreamingResponse:
    """Server-sent events: `run` (cycle started / finished), `alert` (new WATCH or CONFIRMED GO), `alert_summary`,
    `replay`. Streams are short-lived on purpose: an endless stream keeps uvicorn's graceful shutdown (and --reload)
    waiting forever. Events missed between streams are re-sent from a buffer using the Last-Event-ID header."""
    notifier = sentinel.SENTINEL.notifier
    q = notifier.subscribe()
    try:
        last_id = int(request.headers.get("last-event-id") or 0)
    except ValueError:
        last_id = 0

    def frame(msg: dict) -> str:
        return f"id: {msg['_id']}\nevent: {msg['type']}\ndata: {json.dumps(msg, default=str)}\n\n"

    async def gen():
        try:
            yield "retry: 3000\n\n"
            yield f"event: hello\ndata: {json.dumps({'status': sentinel.SENTINEL.status()})}\n\n"
            sent = last_id
            for i, msg in notifier.since(last_id) if last_id else []:
                sent = i
                yield frame(msg)
            deadline = time.monotonic() + SSE_STREAM_MAX_S
            while time.monotonic() < deadline and not await request.is_disconnected():
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=min(10.0, max(0.1, deadline - time.monotonic())))
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if msg["_id"] > sent:
                    sent = msg["_id"]
                    yield frame(msg)
        finally:
            notifier.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ReplayStart(BaseModel):
    event_id: int | None = None


@app.post("/sentinel/replay")
def sentinel_replay_start(req: ReplayStart | None = None) -> dict:
    """Replay a real high-risk ESA Kelvins test event through the AI, decision and guard (historical, not live)."""
    try:
        return sentinel.REPLAY.start(req.event_id if req else None)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(404, str(e)) from None


@app.get("/sentinel/replay")
def sentinel_replay_state() -> dict:
    return sentinel.REPLAY.state or {"active": False}


@app.delete("/sentinel/replay")
def sentinel_replay_stop() -> dict:
    return sentinel.REPLAY.stop() or {"active": False}


@app.get("/health")
def health() -> dict:
    return {"ok": True}
