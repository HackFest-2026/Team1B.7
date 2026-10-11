"""Conjunction screening, collision probability, avoidance-maneuver sizing and re-entry heuristic.

Follows CLAUDE.md "Physics rules": km, km/s, s, UTC; coarse vectorized SGP4 pass (SatrecArray,
60 s step) refined at 1 s; isotropic sigma from TLE age (an ASSUMPTION, TLEs carry
no covariance); Pc = ncx2.cdf((R/sigma)^2, df=2, nc=(d/sigma)^2); along-track drift Δs ≈ 3·Δv·Δt.

Coarse pass (`screen_many`): the catalog is propagated ONCE per block of time steps and, at every 60 s step,
a scipy cKDTree of all catalog positions answers query_ball_point for every protected asset at once. The ball
radius is the step's capture radius (screen_km + VREL_MAX_KMS · step / 2): at 60 s two objects can close
~15 km/s × 30 s between samples, so a literal 10 km ball would miss most crossings. Each hit gets a straight-line
closest approach (±half a step); only those within screen_km + LINEAR_MARGIN_KM go to the 1 s refinement.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy.spatial import cKDTree
from scipy.stats import ncx2
from sgp4.api import Satrec, SatrecArray, jday

import orbit

COARSE_STEP_S = 60
CHUNK = 2000
REFINE_HALF_S = 60  # refine at REFINE_STEP_S over ±60 s around each coarse minimum
REFINE_STEP_S = 1.0
# ASSUMED isotropic 1-sigma position error per object: SIGMA_BASE_KM + SIGMA_PER_DAY_KM × |TLE age at TCA in days|.
SIGMA_BASE_KM = 0.5
SIGMA_PER_DAY_KM = 1.0
ALT_MARGIN_KM = 100.0  # perigee/apogee prefilter margin (mean elements vs osculating radius)
VREL_MAX_KMS = 16.0  # upper bound on LEO relative speed, sets the coarse capture distance
LINEAR_MARGIN_KM = 50.0  # straight-line pre-check margin (curvature) before the 1 s refinement
KD_BLOCK_STEPS = 30  # time steps propagated together in screen_many (memory ≈ catalog × 30 × 6 floats)
FAR_KM = 1e9  # position used for objects SGP4 cannot propagate at a step (never inside any ball)
PC_ALERT = 1e-4  # "alert" (high risk)
PC_WATCH = 1e-6  # "watch"
PC_MANEUVER_TARGET = 1e-6  # maneuvers aim to bring Pc below this
MANEUVER_LEADS_H = (0.5, 1, 2, 6, 12, 24)
REENTRY_N_REVDAY = 16.4  # ~165 km circular altitude; below this, re-entry follows within hours
REENTRY_MAX_PERIGEE_KM = 400.0
REENTRY_MAX_DAYS = 365.0
# ASSUMED: thermospheric density (hence decay rate) scales as F10.7^alpha. Densities near 400 km change by roughly
# an order of magnitude between solar minimum (F10.7 ~70) and maximum (~200), i.e. alpha ~2; lower down the
# change is smaller. 1.5 is a middle value for 200-400 km perigees. Labelled "est." everywhere it is used.
SW_DENSITY_EXPONENT = 1.5
SW_FACTOR_RANGE = (0.33, 3.0)  # clamp on the space-weather scaling of the decay time


# --------------------------------------------------------------------------- catalog index


@dataclass
class CatalogIndex:
    """Pre-parsed satrecs and arrays for fast screening; rebuilt when the catalog changes."""

    entries: list[dict]
    satrecs: list[Satrec]
    norad: np.ndarray
    perigee: np.ndarray
    apogee: np.ndarray
    epoch_jd: np.ndarray
    pos: dict[int, int]


def build_index(entries: list[dict]) -> CatalogIndex:
    keep, recs = [], []
    for e in entries:
        try:
            s = Satrec.twoline2rv(e["tle1"], e["tle2"])
        except Exception:
            continue
        keep.append(e)
        recs.append(s)
    return CatalogIndex(
        entries=keep,
        satrecs=recs,
        norad=np.array([e["norad"] for e in keep], dtype=np.int64),
        perigee=np.array([e["perigee_km"] for e in keep], dtype=float),
        apogee=np.array([e["apogee_km"] for e in keep], dtype=float),
        epoch_jd=np.array([s.jdsatepoch + s.jdsatepochF for s in recs], dtype=float),
        pos={e["norad"]: i for i, e in enumerate(keep)},
    )


# --------------------------------------------------------------------------- helpers


def _jd(t0: datetime, seconds: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Julian date split (whole, fraction) for t0 + seconds, keeping full precision."""
    jd0, fr0 = jday(t0.year, t0.month, t0.day, t0.hour, t0.minute, t0.second + t0.microsecond * 1e-6)
    fr = fr0 + np.asarray(seconds, dtype=float) / 86400.0
    whole = np.floor(fr)
    return jd0 + whole, fr - whole


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sigma_km(tle_age_days: float) -> float:
    """ASSUMED isotropic 1-sigma position error: 0.5 km + 1 km per day of TLE age at TCA."""
    return SIGMA_BASE_KM + SIGMA_PER_DAY_KM * abs(tle_age_days)


def collision_probability(miss_km: float, sigma: float, hbr_km: float) -> float:
    """Pc = P(|x| < R) for a 2-D isotropic Gaussian miss vector: ncx2.cdf((R/s)^2, 2, (d/s)^2)."""
    return float(ncx2.cdf((hbr_km / sigma) ** 2, 2, (miss_km / sigma) ** 2))


def _risk_level(pc: float) -> str:
    return "alert" if pc >= PC_ALERT else "watch" if pc >= PC_WATCH else "low"


def _refine(primary: Satrec, secondary: Satrec, t0: datetime, center_s: float, lo_s: float, hi_s: float, perturb=None):
    """1 s grid over [center-60, center+60] ∩ [lo, hi], then sub-second polish along relative motion.

    `perturb(seconds_from_t0) -> (dr, dv)` (km, km/s) is added to the primary's SGP4 state when given
    (used for post-burn trajectories). Returns (tca_s, miss_km, rel, vrel, v_primary, r_primary) or None if
    SGP4 failed; rel = secondary − primary at TCA, r_primary the primary's position at TCA (TEME km).
    """
    tt = np.arange(max(lo_s, center_s - REFINE_HALF_S), min(hi_s, center_s + REFINE_HALF_S) + 1, REFINE_STEP_S)
    jd, fr = _jd(t0, tt)
    e1, r1, v1 = primary.sgp4_array(jd, fr)
    if perturb is not None:
        dr, dv = perturb(tt)
        r1, v1 = r1 + dr, v1 + dv
    e2, r2, v2 = secondary.sgp4_array(jd, fr)
    d = np.linalg.norm(r2 - r1, axis=1)
    d[(e1 != 0) | (e2 != 0)] = np.inf
    j = int(np.argmin(d))
    if not np.isfinite(d[j]):
        return None
    rel = r2[j] - r1[j]
    vrel = v2[j] - v1[j]
    # Closest approach of the locally linear relative motion, kept within ±1 s of the grid point.
    tau = float(np.clip(-np.dot(rel, vrel) / max(np.dot(vrel, vrel), 1e-12), -1.0, 1.0))
    rel_c = rel + vrel * tau
    return float(tt[j] + tau), float(np.linalg.norm(rel_c)), rel_c, vrel, v1[j], r1[j] + v1[j] * tau


def rtn_separation(rel: np.ndarray, r_primary: np.ndarray, v_primary: np.ndarray) -> tuple[float, float, float]:
    """Miss vector (secondary − primary) in the primary's RTN frame: (radial, in-track, cross-track) km."""
    rh = r_primary / np.linalg.norm(r_primary)
    nh = np.cross(r_primary, v_primary)
    nh /= np.linalg.norm(nh)
    th = np.cross(nh, rh)
    return float(rel @ rh), float(rel @ th), float(rel @ nh)


def conjunction_record(primary_entry: dict, primary: Satrec, sec_entry: dict, secondary: Satrec, t0: datetime, ref, hbr_km: float) -> dict:
    """One /screen result from a refinement `ref` (see _refine), times relative to t0.

    σ is ASSUMED from TLE age at TCA (TLEs carry no covariance). TLE ages are also reported at t0 (screen time).
    """
    tca_s, miss, rel, vrel, v1, r1 = ref
    jw, jf = _jd(t0, np.array([tca_s]))
    tca_jd = float(jw[0] + jf[0])
    p_epoch, s_epoch = primary.jdsatepoch + primary.jdsatepochF, secondary.jdsatepoch + secondary.jdsatepochF
    sig = math.hypot(sigma_km(tca_jd - p_epoch), sigma_km(tca_jd - s_epoch))
    pc = collision_probability(miss, sig, hbr_km)
    radial, in_track, cross = rtn_separation(rel, r1, v1)
    # Where the approach happens: geodetic point midway between the two objects at TCA (WGS-84).
    tca_lat, tca_lon, tca_alt = orbit.teme_to_geodetic(r1 + rel / 2.0, tca_jd)
    jw0, jf0 = _jd(t0, np.array([0.0]))
    now_jd = float(jw0[0] + jf0[0])
    return {
        "norad": sec_entry["norad"],
        "name": sec_entry["name"],
        "object_type": sec_entry["object_type"],
        "tca_utc": _iso(t0 + timedelta(seconds=tca_s)),
        "miss_km": round(miss, 3),
        # Separation at TCA in the protected asset's frame (radial out, in-track along velocity, cross-track normal).
        "radial_km": round(radial, 3),
        "in_track_km": round(in_track, 3),
        "cross_track_km": round(cross, 3),
        "vrel_kms": round(float(np.linalg.norm(vrel)), 3),
        "sigma_km": round(sig, 3),
        "primary_tle_age_h": round((now_jd - p_epoch) * 24.0, 1),
        "secondary_tle_age_h": round((now_jd - s_epoch) * 24.0, 1),
        "pc": pc,
        "alert": pc >= PC_ALERT,
        "level": _risk_level(pc),
        "primary_norad": primary_entry["norad"],
        "primary_object_type": primary_entry["object_type"],
        "primary_name": primary_entry["name"],
        "tca_lat_deg": round(tca_lat, 3),
        "tca_lon_deg": round(tca_lon, 3),
        "tca_alt_km": round(tca_alt, 1),
        # Space-Track RCS_SIZE class (SMALL < 0.1 m², MEDIUM 0.1-1 m², LARGE > 1 m²); None = not provided ("unknown").
        "primary_rcs_size": primary_entry.get("rcs_size"),
        "secondary_rcs_size": sec_entry.get("rcs_size"),
    }


def describe_pair(primary_entry: dict, secondary_entry: dict, tca_utc: datetime, hbr_m: float = 20.0, window_s: float = 120.0) -> dict | None:
    """The /screen record for one known pair near a given TCA (re-refined at 1 s), or None if SGP4 fails."""
    primary = Satrec.twoline2rv(primary_entry["tle1"], primary_entry["tle2"])
    secondary = Satrec.twoline2rv(secondary_entry["tle1"], secondary_entry["tle2"])
    t0 = tca_utc.replace(microsecond=0)
    ref = _refine(primary, secondary, t0, 0.0, -window_s, window_s)
    return None if ref is None else conjunction_record(primary_entry, primary, secondary_entry, secondary, t0, ref, hbr_m / 1000.0)


# --------------------------------------------------------------------------- screening


def screen_many(
    index: CatalogIndex,
    primaries: list[dict],
    horizon_h: float = 24.0,
    screen_km: float = 10.0,
    hbr_m: float = 20.0,
    t0: datetime | None = None,
) -> tuple[list[list[dict]], list[dict], dict]:
    """Screen several assets against the whole catalog with one shared propagation and one cKDTree per step.

    Returns (conjunctions per asset, stats per asset, run stats). Same refinement, σ and Pc as before; per asset a
    perigee/apogee prefilter (±screen_km + 100 km) and the co-located exclusion (objects within screen_km for the
    whole window: docked modules, formation flyers) still apply.
    """
    t_start = time.perf_counter()
    t0 = (t0 or datetime.now(timezone.utc)).replace(microsecond=0)
    horizon_s = horizon_h * 3600.0
    hbr_km = hbr_m / 1000.0
    times = np.arange(0.0, horizon_s + 1e-9, COARSE_STEP_S)
    nt = len(times)
    jd, fr = _jd(t0, times)

    W = len(primaries)
    psat = [Satrec.twoline2rv(e["tle1"], e["tle2"]) for e in primaries]
    pnorad = np.array([e["norad"] for e in primaries], dtype=np.int64)
    ep, rp, vp = SatrecArray(psat).sgp4(jd, fr)  # (W, nt), (W, nt, 3)
    p_ok = ep == 0
    usable = p_ok.any(axis=1)

    # Per-asset altitude band; the catalog subset is the union of all bands.
    lo = np.array([e["perigee_km"] for e in primaries]) - screen_km - ALT_MARGIN_KM
    hi = np.array([e["apogee_km"] for e in primaries]) + screen_km + ALT_MARGIN_KM
    band = (index.apogee[None, :] >= lo[:, None]) & (index.perigee[None, :] <= hi[:, None])  # (W, N)
    band &= usable[:, None]
    band &= index.norad[None, :] != pnorad[:, None]
    cand = np.nonzero(band.any(axis=0))[0]
    band_c = band[:, cand]  # (W, M)
    M = len(cand)
    arr = SatrecArray([index.satrecs[i] for i in cand]) if M else None

    capture_km = screen_km + VREL_MAX_KMS * COARSE_STEP_S / 2
    keep_km = screen_km + LINEAR_MARGIN_KM
    tau_max = 0.6 * COARSE_STEP_S  # straight-line search a little beyond half a step
    close_counts = np.zeros(W * max(M, 1), dtype=np.int32)  # steps with d < screen_km, per (asset, object)
    valid_c = np.zeros(M, dtype=np.int32)  # steps each object propagated
    hits = 0
    found: list[np.ndarray] = []  # rows: w, m, t_est, d_lin
    t_prop = t_tree = 0.0
    for b0 in range(0, nt if M else 0, KD_BLOCK_STEPS):
        b1 = min(b0 + KD_BLOCK_STEPS, nt)
        tp = time.perf_counter()
        e, r, v = arr.sgp4(jd[b0:b1], fr[b0:b1])  # (M, B, 3)
        t_prop += time.perf_counter() - tp
        tq = time.perf_counter()
        ok = e == 0
        valid_c += ok.sum(axis=1).astype(np.int32)
        for k in range(b1 - b0):
            step = b0 + k
            ws = np.nonzero(p_ok[:, step])[0]
            if not len(ws):
                continue
            pos = np.where(ok[:, k, None], r[:, k], FAR_KM)
            tree = cKDTree(pos, balanced_tree=False, compact_nodes=False)
            nb = tree.query_ball_point(rp[ws, step], capture_km, return_sorted=False)
            lens = np.fromiter((len(x) for x in nb), dtype=np.int64, count=len(ws))
            if not lens.sum():
                continue
            wi = np.repeat(ws, lens)
            mi = np.concatenate([np.asarray(x, dtype=np.int64) for x in nb if len(x)])
            sel = band_c[wi, mi]
            wi, mi = wi[sel], mi[sel]
            hits += len(wi)
            if not len(wi):
                continue
            rel = r[mi, k] - rp[wi, step]
            vrel = v[mi, k] - vp[wi, step]
            d = np.linalg.norm(rel, axis=1)
            close = d < screen_km
            if close.any():
                np.add.at(close_counts, wi[close] * M + mi[close], 1)
            tau = np.clip(-np.einsum("ij,ij->i", rel, vrel) / np.maximum(np.einsum("ij,ij->i", vrel, vrel), 1e-12), -tau_max, tau_max)
            dlin = np.linalg.norm(rel + vrel * tau[:, None], axis=1)
            near = dlin < keep_km
            if near.any():
                found.append(np.column_stack([wi[near], mi[near], times[step] + tau[near], dlin[near]]))
        t_tree += time.perf_counter() - tq
    t_coarse = time.perf_counter() - t_start

    # Co-located: within screen_km at every step both objects propagated.
    both_valid = np.minimum(p_ok.sum(axis=1)[:, None], valid_c[None, :]) if M else np.zeros((W, 0))
    cc = close_counts[: W * M].reshape(W, M) if M else np.zeros((W, 0))
    colocated = (cc > 0) & (cc >= both_valid)

    # One refinement per (asset, object, ~5-minute window), centred on the best straight-line estimate.
    t_ref = time.perf_counter()
    events: list[dict[tuple[int, int], dict]] = [{} for _ in range(W)]
    refined = 0
    if found:
        F = np.vstack(found)
        F = F[~colocated[F[:, 0].astype(int), F[:, 1].astype(int)]]
        order = np.lexsort((F[:, 3], np.round(F[:, 2] / 300.0), F[:, 1], F[:, 0]))
        F = F[order]
        keys = np.column_stack([F[:, 0], F[:, 1], np.round(F[:, 2] / 300.0)])
        first = np.ones(len(F), bool)
        first[1:] = np.any(keys[1:] != keys[:-1], axis=1)
        for w, m, t_est, _ in F[first]:
            w, m = int(w), int(m)
            i = int(cand[m])
            ref = _refine(psat[w], index.satrecs[i], t0, float(t_est), 0.0, horizon_s)
            refined += 1
            if ref is None or ref[1] > screen_km:
                continue
            key = (i, int(round(ref[0] / 300)))
            if key in events[w] and events[w][key]["miss_km"] <= ref[1]:
                continue
            events[w][key] = conjunction_record(primaries[w], psat[w], index.entries[i], index.satrecs[i], t0, ref, hbr_km)
    t_ref = time.perf_counter() - t_ref

    elapsed = time.perf_counter() - t_start
    results, per = [], []
    for w, pe in enumerate(primaries):
        res = sorted(events[w].values(), key=lambda c: (-c["pc"], c["miss_km"]))
        results.append(res)
        co = [int(index.norad[cand[m]]) for m in np.nonzero(colocated[w])[0]] if M else []
        pairs = len(index.entries) - (1 if pe["norad"] in index.pos else 0)
        per.append({
            "primary_norad": pe["norad"],
            "window_start_utc": _iso(t0),
            "horizon_h": horizon_h,
            "screen_km": screen_km,
            "hbr_m": hbr_m,
            "objects_in_catalog": pairs,
            "pairs_after_altitude_filter": int(band_c[w].sum()) if M else 0,
            "co_located_excluded": len(co),
            "co_located_norads": co[:50],
            "conjunctions": len(res),
            "alerts": sum(1 for c in res if c["alert"]),
            "propagated": bool(usable[w]),
        })
    run = {
        "method": "shared SGP4 propagation + scipy cKDTree per 60 s step (query_ball_point), 1 s refinement",
        "window_start_utc": _iso(t0),
        "horizon_h": horizon_h,
        "screen_km": screen_km,
        "capture_radius_km": capture_km,
        "assets": W,
        "objects_propagated": int(M),
        "time_steps": int(nt),
        "kdtree_hits": int(hits),
        "refined_candidates": int(refined),
        "pairs_checked": int(band_c.sum()) if M else 0,
        "seconds": round(elapsed, 2),
        "seconds_split": {"propagation": round(t_prop, 2), "kdtree": round(t_tree, 2), "refine": round(t_ref, 2)},
        "coarse_seconds": round(t_coarse, 2),
    }
    return results, per, run


def screen(
    index: CatalogIndex,
    primary_entry: dict,
    horizon_h: float = 24.0,
    screen_km: float = 10.0,
    hbr_m: float = 20.0,
    t0: datetime | None = None,
) -> tuple[list[dict], dict]:
    """Screen one asset against the whole catalog (screen_many with one asset). Returns (conjunctions, stats)."""
    probe = Satrec.twoline2rv(primary_entry["tle1"], primary_entry["tle2"])
    t = (t0 or datetime.now(timezone.utc)).replace(microsecond=0)
    jd, fr = _jd(t, np.arange(0.0, horizon_h * 3600.0 + 1e-9, COARSE_STEP_S))
    if np.all(probe.sgp4_array(jd, fr)[0] != 0):
        raise ValueError("SGP4 cannot propagate the protected asset over this window.")
    results, per, run = screen_many(index, [primary_entry], horizon_h, screen_km, hbr_m, t)
    stats = {
        **per[0],
        "method": run["method"],
        "coarse_pair_epochs": int(per[0]["pairs_after_altitude_filter"] * run["time_steps"]),
        "kdtree_hits": run["kdtree_hits"],
        "refined_candidates": run["refined_candidates"],
        "seconds": run["seconds"],
        "coarse_seconds": run["coarse_seconds"],
        "seconds_split": run["seconds_split"],
    }
    el = run["seconds"]
    # Catalog pairs (asset vs every other object) resolved per second, prefilter included.
    stats["pairs_per_sec"] = round(stats["objects_in_catalog"] / el) if el > 0 else None
    # Pair-epochs covered per second by the coarse pass (every pair in the band, every step).
    stats["pair_epochs_per_sec"] = round(stats["coarse_pair_epochs"] / run["coarse_seconds"]) if run["coarse_seconds"] > 0 else None
    return results[0], stats


def screen_paths(
    index: CatalogIndex,
    primary_entry: dict,
    t0: datetime,
    horizon_s: float,
    perturbations: list,
    screen_km: float = 10.0,
    hbr_m: float = 20.0,
    skip: frozenset[int] = frozenset(),
) -> tuple[list[list[dict]], list[int], dict]:
    """Screen several versions of one asset's trajectory against the catalog in ONE SGP4 pass.

    perturbations[0] must be None (the asset as published); perturbations[k] for k >= 1 is a callable
    f(seconds_from_t0) -> (dr, dv) added to the asset's SGP4 state (e.g. a burn's effect, zero before the burn).
    The catalog is propagated once per chunk and compared with every path, so screening ~10 candidate
    burns costs little more than one screen. Same coarse/refine method and Pc/σ assumptions as `screen`.
    Objects co-located with the PUBLISHED path for the whole window (docked modules, attached vehicles)
    are excluded from every path: they move with the asset physically, but their TLEs would not.
    Returns (events per path, co-located NORAD IDs, stats).
    """
    assert perturbations and perturbations[0] is None
    t_start = time.perf_counter()
    hbr_km = hbr_m / 1000.0
    pnorad = primary_entry["norad"]
    primary = Satrec.twoline2rv(primary_entry["tle1"], primary_entry["tle2"])
    p_epoch_jd = primary.jdsatepoch + primary.jdsatepochF

    times = np.arange(0.0, horizon_s + 1e-9, COARSE_STEP_S)
    jd, fr = _jd(t0, times)
    ep, rp, vp = primary.sgp4_array(jd, fr)
    if np.all(ep != 0):
        raise ValueError("SGP4 cannot propagate the asset over this window.")
    paths, vpaths = [rp], [vp]
    for f in perturbations[1:]:
        dr, dv = f(times)
        paths.append(rp + dr)
        vpaths.append(vp + dv)

    # Altitude-band prefilter from the actual radii of all paths (burns change the shell).
    alts = np.concatenate([np.linalg.norm(p[ep == 0], axis=1) for p in paths]) - 6378.137
    p_lo, p_hi = alts.min() - screen_km - ALT_MARGIN_KM, alts.max() + screen_km + ALT_MARGIN_KM
    mask = (index.apogee >= p_lo) & (index.perigee <= p_hi) & (index.norad != pnorad)
    for n in skip:
        if n in index.pos:
            mask[index.pos[n]] = False
    candidates = np.nonzero(mask)[0]

    capture_km = screen_km + VREL_MAX_KMS * COARSE_STEP_S / 2
    minima: list[list[tuple[int, float]]] = [[] for _ in paths]
    co_located: list[int] = []
    linear_keep_km = screen_km + LINEAR_MARGIN_KM
    for start in range(0, len(candidates), CHUNK):
        idx = candidates[start : start + CHUNK]
        e, r, v = SatrecArray([index.satrecs[i] for i in idx]).sgp4(jd, fr)
        bad = (e != 0) | (ep[None, :] != 0)
        attached = None
        for k, pk in enumerate(paths):
            d = np.linalg.norm(r - pk[None, :, :], axis=2)
            d[bad] = np.inf
            if k == 0:
                dmax = np.where(np.isfinite(d), d, -np.inf).max(axis=1)
                attached = np.isfinite(dmax) & (dmax >= 0) & (dmax < screen_km)
                co_located += [int(index.norad[i]) for i in idx[attached]]
            d[attached] = np.inf
            interior = (d[:, 1:-1] <= d[:, :-2]) & (d[:, 1:-1] <= d[:, 2:]) & (d[:, 1:-1] < capture_km)
            rows, cols = np.nonzero(interior)
            cols = cols + 1
            for edge, nb in ((0, 1), (len(times) - 1, len(times) - 2)):
                hit = np.nonzero((d[:, edge] < capture_km) & (d[:, edge] <= d[:, nb]))[0]
                rows = np.concatenate([rows, hit])
                cols = np.concatenate([cols, np.full(len(hit), edge)])
            if len(rows) == 0:
                continue
            # Cheap straight-line closest approach within ±1 coarse step of the sample; only minima that
            # could come within screen_km (+ margin for curvature) get the full 1 s refinement.
            rel = r[rows, cols] - pk[cols]
            vrel = v[rows, cols] - vpaths[k][cols]
            tau = np.clip(-np.einsum("ij,ij->i", rel, vrel) / np.maximum(np.einsum("ij,ij->i", vrel, vrel), 1e-12), -COARSE_STEP_S, COARSE_STEP_S)
            dlin = np.linalg.norm(rel + vrel * tau[:, None], axis=1)
            keep = dlin < linear_keep_km
            minima[k] += [(int(idx[a]), float(times[b])) for a, b in zip(rows[keep], cols[keep])]
    t_coarse = time.perf_counter() - t_start

    out: list[list[dict]] = []
    for k, mins in enumerate(minima):
        f = perturbations[k]
        events: dict[tuple[int, int], dict] = {}
        for i, center in mins:
            ref = _refine(primary, index.satrecs[i], t0, center, 0.0, horizon_s, perturb=f)
            if ref is None:
                continue
            tca_s, miss, _, vrel, _, _ = ref
            if miss > screen_km:
                continue
            key = (i, int(round(tca_s / 300)))
            if key in events and events[key]["miss_km"] <= miss:
                continue
            jw, jf = _jd(t0, np.array([tca_s]))
            tca_jd = float(jw[0] + jf[0])
            sig = math.hypot(sigma_km(tca_jd - p_epoch_jd), sigma_km(tca_jd - index.epoch_jd[i]))
            sec = index.entries[i]
            events[key] = {
                "norad": sec["norad"],
                "name": sec["name"],
                "object_type": sec["object_type"],
                "tca_utc": _iso(t0 + timedelta(seconds=tca_s)),
                "miss_km": round(miss, 3),
                "vrel_kms": round(float(np.linalg.norm(vrel)), 3),
                "sigma_km": round(sig, 3),
                "pc": collision_probability(miss, sig, hbr_km),
            }
        out.append(sorted(events.values(), key=lambda c: (-c["pc"], c["miss_km"])))
    stats = {
        "window_start_utc": _iso(t0),
        "horizon_h": round(horizon_s / 3600.0, 2),
        "paths": len(paths),
        "objects_in_catalog": len(index.entries) - (1 if pnorad in index.pos else 0),
        "pairs_after_altitude_filter": int(len(candidates)),
        "co_located_excluded": len(co_located),
        "seconds": round(time.perf_counter() - t_start, 2),
        "coarse_seconds": round(t_coarse, 2),
    }
    return out, co_located, stats


# --------------------------------------------------------------------------- throughput benchmark


def all_vs_all_slice(index: CatalogIndex, slice_h: float = 1.0, screen_km: float = 10.0, t0: datetime | None = None,
                     refine_sample: int = 300, seed: int = 42) -> dict:
    """MEASURE one time slice of an all-vs-all screen (every object against every other), to extrapolate from.

    Per 60 s step: SGP4 for the whole catalog, cKDTree.query_pairs at the capture radius, straight-line closest
    approach for every pair found. A random sample of the surviving candidates is refined at 1 s to time that step.
    """
    t_start = time.perf_counter()
    t0 = (t0 or datetime.now(timezone.utc)).replace(microsecond=0)
    times = np.arange(0.0, slice_h * 3600.0, COARSE_STEP_S)
    jd, fr = _jd(t0, times)
    arr = SatrecArray(index.satrecs)
    capture_km = screen_km + VREL_MAX_KMS * COARSE_STEP_S / 2
    keep_km = screen_km + LINEAR_MARGIN_KM
    tau_max = 0.6 * COARSE_STEP_S
    pairs_found = 0
    cands: list[np.ndarray] = []
    t_prop = t_tree = 0.0
    for b0 in range(0, len(times), KD_BLOCK_STEPS):
        b1 = min(b0 + KD_BLOCK_STEPS, len(times))
        tp = time.perf_counter()
        e, r, v = arr.sgp4(jd[b0:b1], fr[b0:b1])
        t_prop += time.perf_counter() - tp
        tq = time.perf_counter()
        for k in range(b1 - b0):
            ok = e[:, k] == 0
            pos = np.where(ok[:, None], r[:, k], FAR_KM)
            pr = cKDTree(pos, balanced_tree=False, compact_nodes=False).query_pairs(capture_km, output_type="ndarray")
            pairs_found += len(pr)
            if not len(pr):
                continue
            a, b = pr[:, 0], pr[:, 1]
            rel, vrel = r[b, k] - r[a, k], v[b, k] - v[a, k]
            tau = np.clip(-np.einsum("ij,ij->i", rel, vrel) / np.maximum(np.einsum("ij,ij->i", vrel, vrel), 1e-12), -tau_max, tau_max)
            near = np.linalg.norm(rel + vrel * tau[:, None], axis=1) < keep_km
            cands.append(np.column_stack([a[near], b[near], times[b0 + k] + tau[near]]))
        t_tree += time.perf_counter() - tq
    C = np.vstack(cands) if cands else np.zeros((0, 3))
    rng = np.random.default_rng(seed)
    pick = C[rng.choice(len(C), size=min(refine_sample, len(C)), replace=False)] if len(C) else C
    tr = time.perf_counter()
    for a, b, tc in pick:
        _refine(index.satrecs[int(a)], index.satrecs[int(b)], t0, float(tc), 0.0, slice_h * 3600.0)
    per_refine = (time.perf_counter() - tr) / max(len(pick), 1)
    return {
        "slice_h": slice_h, "time_steps": len(times), "objects": len(index.entries), "capture_radius_km": capture_km,
        "kdtree_pairs_found": int(pairs_found), "refine_candidates": int(len(C)),
        "seconds": {"propagation": round(t_prop, 2), "kdtree_and_filter": round(t_tree, 2), "per_refine": round(per_refine, 5),
                    "total_measured": round(time.perf_counter() - t_start, 2)},
    }


def benchmark(index: CatalogIndex, watch_entries: list[dict], reference_norad: int = 25544, horizon_h: float = 72.0,
              slice_h: float = 1.0) -> dict:
    """MEASURED screening throughput, serial on one core (sgp4's SatrecArray does not release the GIL):

    1. one object (the ISS) against the full catalog over `horizon_h`;
    2. the whole Sentinel watchlist against the full catalog over `horizon_h`, one shared pass (screen_many);
    3. all-vs-all: a measured `slice_h` slice extrapolated linearly to `horizon_h` (an ESTIMATE; refinements
       counted as they would scale: candidates in the slice × horizon/slice × measured time per refinement).
    """
    t0 = datetime.now(timezone.utc).replace(microsecond=0)
    out: dict = {"measured_utc": _iso(t0), "catalog_objects": len(index.entries), "horizon_h": horizon_h, "screen_km": 10.0}
    ref_i = index.pos.get(reference_norad)
    if ref_i is not None:
        e = index.entries[ref_i]
        res, st = screen(index, e, horizon_h=horizon_h, screen_km=10.0, t0=t0)
        out["reference"] = {"norad": e["norad"], "name": e["name"], "seconds": st["seconds"], "seconds_split": st["seconds_split"],
                            "pairs_after_altitude_filter": st["pairs_after_altitude_filter"], "pairs_per_sec": st["pairs_per_sec"],
                            "conjunctions": len(res)}
    if watch_entries:
        res, per, run = screen_many(index, watch_entries, horizon_h=horizon_h, screen_km=10.0, t0=t0)
        out["watchlist"] = {"objects": len(watch_entries), "seconds": run["seconds"], "seconds_split": run["seconds_split"],
                            "objects_propagated": run["objects_propagated"], "pairs_checked": run["pairs_checked"],
                            "conjunctions": sum(len(r) for r in res),
                            "seconds_per_object": round(run["seconds"] / len(watch_entries), 2)}
    sl = all_vs_all_slice(index, slice_h=slice_h, t0=t0)
    scale = horizon_h / slice_h
    est = (sl["seconds"]["propagation"] + sl["seconds"]["kdtree_and_filter"]) * scale + sl["refine_candidates"] * scale * sl["seconds"]["per_refine"]
    n = len(index.entries)
    out["all_vs_all_estimate"] = {
        "seconds": round(est), "hours": round(est / 3600.0, 2), "unique_pairs": n * (n - 1) // 2, "slice": sl,
        "basis": f"est.: measured {slice_h:g} h slice of an all-vs-all cKDTree screen (query_pairs per 60 s step), scaled to {horizon_h:g} h; serial, one core",
    }
    return out


# --------------------------------------------------------------------------- maneuver


def maneuver(primary_entry: dict, secondary_entry: dict, tca_utc: datetime, hbr_m: float = 20.0, now: datetime | None = None) -> list[dict]:
    """Along-track burn sizes per lead time that bring Pc below PC_MANEUVER_TARGET.

    Model (CLAUDE.md): a tangential burn Δv applied Δt before TCA shifts the asset along-track by
    Δs ≈ 3·Δv·Δt (prograde burns make it arrive later: Δs = −3·Δv·Δt). The new miss distance is the
    shifted relative position projected on the encounter plane (⊥ relative velocity). Estimates only.
    """
    now = (now or datetime.now(timezone.utc)).replace(microsecond=0)
    primary = Satrec.twoline2rv(primary_entry["tle1"], primary_entry["tle2"])
    secondary = Satrec.twoline2rv(secondary_entry["tle1"], secondary_entry["tle2"])
    ref = _refine(primary, secondary, tca_utc, 0.0, -REFINE_HALF_S, REFINE_HALF_S)
    if ref is None:
        raise ValueError("SGP4 failed near the given TCA.")
    tca_off, miss0, rel, vrel, vp, _ = ref
    tca = tca_utc + timedelta(seconds=tca_off)
    tca_jd = sum(x[0] for x in _jd(tca, np.array([0.0])))
    sig = math.hypot(
        sigma_km(tca_jd - (primary.jdsatepoch + primary.jdsatepochF)),
        sigma_km(tca_jd - (secondary.jdsatepoch + secondary.jdsatepochF)),
    )
    hbr_km = hbr_m / 1000.0
    pc0 = collision_probability(miss0, sig, hbr_km)

    # Miss distance needed for Pc < target (Pc falls monotonically with distance): bisection.
    lo, hi = 0.0, 60.0 * sig + hbr_km
    for _ in range(80):
        mid = (lo + hi) / 2
        if collision_probability(mid, sig, hbr_km) > PC_MANEUVER_TARGET:
            lo = mid
        else:
            hi = mid
    d_star = hi * 1.02  # small margin

    vhat = vrel / np.linalg.norm(vrel)
    p = rel - np.dot(rel, vhat) * vhat  # miss vector in the encounter plane
    that = vp / np.linalg.norm(vp)
    q = that - np.dot(that, vhat) * vhat  # along-track direction seen in the encounter plane
    # Relative position after shifting the asset by Δs along-track: rel - Δs·t̂ → plane miss |p - Δs·q|.
    a, b, c = float(np.dot(q, q)), float(-2 * np.dot(p, q)), float(np.dot(p, p) - d_star**2)

    rows = []
    to_tca_h = (tca - now).total_seconds() / 3600.0
    for lead_h in MANEUVER_LEADS_H:
        if lead_h > to_tca_h:
            continue
        base = {"lead_h": lead_h, "baseline_miss_km": round(miss0, 3), "baseline_pc": pc0, "sigma_km": round(sig, 3), "target_pc": PC_MANEUVER_TARGET}
        if pc0 <= PC_MANEUVER_TARGET:
            rows.append({**base, "dv_ms": 0.0, "direction": "none", "new_miss_km": round(miss0, 3), "new_pc": pc0, "feasible": True})
            continue
        if a < 1e-8 or b * b - 4 * a * c < 0:
            rows.append({**base, "dv_ms": None, "direction": None, "new_miss_km": None, "new_pc": None, "feasible": False})
            continue
        roots = [(-b + sgn * math.sqrt(b * b - 4 * a * c)) / (2 * a) for sgn in (1, -1)]
        ds = min(roots, key=abs)  # km, along-track shift of the asset at TCA
        dt = lead_h * 3600.0
        dv_kms = -ds / (3 * dt)  # Δs = -3·Δv·Δt
        new_miss = float(np.linalg.norm(p - ds * q))
        rows.append(
            {
                **base,
                "dv_ms": round(dv_kms * 1000.0, 4),
                "direction": "prograde" if dv_kms > 0 else "retrograde",
                "new_miss_km": round(new_miss, 3),
                "new_pc": collision_probability(new_miss, sig, hbr_km),
                "feasible": True,
            }
        )
    return rows


# --------------------------------------------------------------------------- re-entry heuristic


def _ndot_half(tle1: str) -> float | None:
    """TLE line 1 cols 34-43: first derivative of mean motion / 2, rev/day^2."""
    try:
        return float(tle1[33:43].replace(" ", ""))
    except ValueError:
        return None


def _forecast_mean(days: list[dict], start: datetime, span_days: float) -> float | None:
    """Mean forecast F10.7 over [start, start + span] from the 27-day outlook; beyond its last day, persistence
    of the outlook's own mean (ASSUMED)."""
    future = [d for d in days if d["date"] >= start.date().isoformat()]
    if not future:
        return None
    n = max(1, int(math.ceil(span_days)))
    vals = [d["f107"] for d in future[:n]]
    if n > len(vals):
        tail = sum(d["f107"] for d in future) / len(future)
        vals += [tail] * (n - len(vals))
    return sum(vals) / len(vals)


def reentry(entries: list[dict], now: datetime | None = None, limit: int = 25, solar: dict | None = None) -> list[dict]:
    """HEURISTIC (est.): days until mean motion reaches ~16.4 rev/day at the TLE's current decay rate.

    est_days_raw = (16.4 - n) / (dn/dt) - (days since epoch), with dn/dt = 2 × TLE ndot/2 term.
    Decay accelerates as perigee drops, so this tends to OVERestimate the remaining time.

    Space weather (est.), when `solar` = {"f107_recent": observed 27-day mean, "days": NOAA 27-day outlook rows}
    is given: the TLE's decay rate reflects recent solar activity, so the time is scaled by
    (F10.7 recent / F10.7 forecast mean over the decay window)^SW_DENSITY_EXPONENT (two fixed-point passes).
    """
    now = now or datetime.now(timezone.utc)
    f_recent = (solar or {}).get("f107_recent")
    outlook = (solar or {}).get("days") or []
    out = []
    for e in entries:
        if e["perigee_km"] > REENTRY_MAX_PERIGEE_KM:
            continue
        half = _ndot_half(e["tle1"])
        try:
            n = float(e["tle2"][52:63])
        except ValueError:
            continue
        if half is None or half <= 0:
            continue
        age_d = (now - datetime.fromisoformat(e["epoch"].replace("Z", "+00:00"))).total_seconds() / 86400.0
        raw = (REENTRY_N_REVDAY - n) / (2 * half) - age_d
        est_raw = max(0.0, raw)
        est, factor, f_fc = est_raw, None, None
        if f_recent and outlook and est_raw > 0:
            for _ in range(2):
                f_fc = _forecast_mean(outlook, now, max(est, 1.0))
                if not f_fc:
                    break
                factor = min(max((f_recent / f_fc) ** SW_DENSITY_EXPONENT, SW_FACTOR_RANGE[0]), SW_FACTOR_RANGE[1])
                est = est_raw * factor
        if est > REENTRY_MAX_DAYS:
            continue
        out.append(
            {
                "norad": e["norad"],
                "name": e["name"],
                "object_type": e["object_type"],
                "perigee_km": e["perigee_km"],
                "apogee_km": e["apogee_km"],
                "est_days": round(est, 1),
                "est_days_raw": round(est_raw, 1),
                "sw_factor": round(factor, 3) if factor is not None else None,
                "f107_recent": f_recent,
                "f107_forecast_mean": round(f_fc, 1) if f_fc else None,
                "risk": "high" if est < 7 else "medium" if est < 30 else "low",
                "tle_age_days": round(age_d, 1),
                # Estimated date already passed since the TLE epoch: imminent or already re-entered.
                "overdue": raw < 0,
                "basis": ("heuristic: mean-motion derivative, scaled by the NOAA SWPC 27-day F10.7 outlook (est.)" if factor is not None
                          else "heuristic: mean-motion derivative (est.); imminent (est.), estimated date already passed, nothing to scale" if est_raw == 0 and f_recent and outlook
                          else "heuristic: mean-motion derivative (est.); space-weather outlook unavailable"),
            }
        )
    out.sort(key=lambda r: r["est_days"])
    return out[:limit]
