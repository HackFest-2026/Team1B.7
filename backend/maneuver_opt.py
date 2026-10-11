"""Collision-avoidance manoeuvre (CAM) planning.

Only PAYLOAD objects are assumed able to manoeuvre (debris, rocket bodies and unknown objects have no
propulsion). The burn is planned for the payload; if both are payloads, for the protected (primary) object.

Burn model (impulsive, RTN frame):
  At the burn time the manoeuvring object's state comes from SGP4. Two copies are propagated numerically
  from the burn to TCA (+1 h) with two-body + J2 (scipy solve_ivp, DOP853, rtol 1e-11): one without the burn
  and one with Δv added. Post-burn position = SGP4 position + (burned − unburned). This keeps SGP4's accuracy
  for the orbit and adds only the burn's effect. All burned copies for one burn time are integrated together
  with the unburned copy in a single system, so they share step sizes and integration errors largely cancel
  in the difference.

Search grid: ±along-track, ±radial, ±cross-track × 25 log-spaced magnitudes (0.005–2 m/s) × burn times
0.5/1/2/3 orbits before TCA (only those at least 1 h from now and at most 72 h before TCA).
Each candidate's new miss distance and Pc use the same Pc function and σ assumptions as risk.py.

Constraint: the ~10 smallest-Δv candidates that reach the target are re-screened against the full catalog
from burn time to TCA + 24 h (risk.screen_paths). A candidate is rejected if it creates a conjunction with
Pc > 1e-5 or miss < 1 km that the unburned orbit does not have.

Lead-time curve (est.): minimum Δv that reaches the target Pc as a function of burn time, 0.1–6 orbits before TCA.
One numerical state-transition matrix (two-body + J2, finite differences, integrated backward from TCA and inverted
with the symplectic identity) gives the linear response of the position at TCA to a Δv at any burn time; the new miss is that shift projected on the encounter plane
(⟂ relative velocity). It is checked against the full non-linear grid at the evaluated burn times.

Fuel (Tsiolkovsky, with_fuel): avoidance burn, a return-to-orbit burn ASSUMED equal in Δv (est., not simulated),
tank share (tank ASSUMED 10 % of wet mass unless given) and the equivalent days of station-keeping
(ASSUMED 10 m/s per year unless given).
"""
from __future__ import annotations

import math
import threading
import time
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import brentq
from sgp4.api import Satrec

import risk

MU = 398600.4418  # km^3/s^2
RE = 6378.137  # km
J2 = 1.08262668e-3
G0 = 9.80665  # m/s^2, standard gravity (Tsiolkovsky)

DEFAULT_MASS_KG = 500.0  # ASSUMED
DEFAULT_ISP_S = 220.0  # ASSUMED (monopropellant hydrazine)
DEFAULT_TARGET_PC = 1e-5
DEFAULT_TANK_FRACTION = 0.10  # ASSUMED: propellant tank capacity = 10 % of wet mass
DEFAULT_SK_MS_PER_YEAR = 10.0  # ASSUMED: yearly station-keeping Δv budget
TOP_OPTIONS = 5

DV_GRID_MS = np.logspace(np.log10(0.005), np.log10(2.0), 25)
ORBITS_BEFORE = (0.5, 1.0, 2.0, 3.0)
MIN_BURN_AFTER_NOW_S = 3600.0
MAX_LEAD_S = 72 * 3600.0
GRID_AFTER_TCA_S = 3600.0  # burn model propagates to TCA + 1 h
TCA_WINDOW_S = 900  # search ± this many seconds around the original TCA for the post-burn closest approach
PATH_AFTER_TCA_S = 1800.0  # globe path: burn point to TCA + 30 min
PATH_STEP_S = 30.0
CONSTRAINT_AFTER_TCA_S = 24 * 3600.0
CONSTRAINT_SCREEN_KM = 10.0
CONSTRAINT_BATCH = 10
NEW_CONJ_PC = 1e-5
NEW_CONJ_MISS_KM = 1.0
AVOIDED_EVENT_WINDOW_S = 600.0  # an event with the same secondary within ±10 min of TCA is the one being avoided
DEADLINE_MAX_DV_MS = 1.0
LEAD_CURVE_MIN_ORBITS = 0.1
LEAD_CURVE_MAX_ORBITS = 6.0
LEAD_CURVE_POINTS = 48
LEAD_CURVE_MIN_VREL_KMS = 0.1  # below this the straight-line encounter-plane model does not hold
STM_DR_KM = 1e-2  # finite-difference perturbations for the state-transition matrix
STM_DV_KMS = 1e-5
RTOL, ATOL = 1e-11, 1e-12
CACHE_TTL_S = 15 * 60

# key, label, unit vector in (R, T, N)
DIRECTIONS = [
    ("+T", "Along-track + (prograde)", (0.0, 1.0, 0.0)),
    ("-T", "Along-track − (retrograde)", (0.0, -1.0, 0.0)),
    ("+R", "Radial + (outward)", (1.0, 0.0, 0.0)),
    ("-R", "Radial − (inward)", (-1.0, 0.0, 0.0)),
    ("+N", "Cross-track + (orbit normal)", (0.0, 0.0, 1.0)),
    ("-N", "Cross-track − (anti-normal)", (0.0, 0.0, -1.0)),
]

ASSUMPTIONS = [
    "Only objects catalogued as PAYLOAD are assumed able to manoeuvre; many payloads are defunct or have no propulsion.",
    "Impulsive burn (instantaneous Δv in the RTN frame); real thrusters take seconds to minutes.",
    "Burn effect from two-body + J2 numerical propagation, added to the SGP4 orbit; drag, solar pressure and third bodies are ignored for the difference.",
    "Uncertainty unchanged by the burn: σ = 0.5 km + 1 km per day of TLE age per object (same as screening). Burn execution errors are not modelled.",
    "Burn times evaluated only at 0.5, 1, 2 and 3 orbits before TCA, at least 1 h from now and at most 72 h before TCA.",
    "New-conjunction check: the post-burn orbit is re-screened against the full catalog from burn time to TCA + 24 h (Pc > 1e-5 or miss < 1 km).",
    "Return-to-orbit burn est.: assumed equal in Δv to the avoidance burn (not simulated).",
    "Lead-time curve est.: linearised burn response (state-transition matrix, two-body + J2) projected on the encounter plane; the dots are the full non-linear grid.",
]

_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


# --------------------------------------------------------------------------- dynamics


def _rhs(_t: float, y: np.ndarray) -> np.ndarray:
    """Two-body + J2 for N stacked copies (state 6N: r km, v km/s)."""
    s = y.reshape(-1, 6)
    r = s[:, :3]
    r2 = np.einsum("ij,ij->i", r, r)
    rn = np.sqrt(r2)
    a = -MU * r / (rn**3)[:, None]
    f = 1.5 * J2 * MU * RE**2 / rn**5
    zz = 5.0 * r[:, 2] ** 2 / r2
    a[:, 0] += f * r[:, 0] * (zz - 1.0)
    a[:, 1] += f * r[:, 1] * (zz - 1.0)
    a[:, 2] += f * r[:, 2] * (zz - 3.0)
    return np.hstack([s[:, 3:], a]).ravel()


def _propagate(r0: np.ndarray, v0: np.ndarray, dvs_kms: np.ndarray, duration_s: float):
    """Copy 0 unburned, copies 1..k with dvs_kms[k-1] added at t = 0. Returns a dense solution."""
    n = 1 + len(dvs_kms)
    y0 = np.tile(np.concatenate([r0, v0]), (n, 1))
    y0[1:, 3:] += dvs_kms
    sol = solve_ivp(_rhs, (0.0, duration_s), y0.ravel(), method="DOP853", rtol=RTOL, atol=ATOL, dense_output=True)
    if not sol.success:
        raise RuntimeError(f"orbit integration failed: {sol.message}")
    return sol


def _deltas(sol, s: np.ndarray, duration_s: float) -> tuple[np.ndarray, np.ndarray]:
    """Burned − unburned at IVP times s: (copies-1, len(s), 3) position and velocity differences."""
    y = sol.sol(np.clip(s, 0.0, duration_s))
    y = y.reshape(-1, 6, len(s))
    d = y[1:] - y[:1]
    return d[:, :3].transpose(0, 2, 1), d[:, 3:].transpose(0, 2, 1)


def _rtn(r: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rows: unit R (radial), T (along-track, in-plane ⟂ R), N (orbit normal)."""
    rh = r / np.linalg.norm(r)
    h = np.cross(r, v)
    nh = h / np.linalg.norm(h)
    th = np.cross(nh, rh)
    return np.vstack([rh, th, nh])


def _sgp4_at(sat: Satrec, t: datetime, seconds: np.ndarray):
    jd, fr = risk._jd(t, seconds)
    return sat.sgp4_array(jd, fr)


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def propellant_kg(dv_ms: float, mass_kg: float, isp_s: float) -> float:
    """Tsiolkovsky: m0 · (1 − exp(−Δv / (Isp · g0)))."""
    return mass_kg * (1.0 - math.exp(-dv_ms / (isp_s * G0)))


# --------------------------------------------------------------------------- who can move


def choose_maneuvering(primary: dict, secondary: dict):
    """(manoeuvring entry, other entry, role) or None if neither object can manoeuvre."""
    if primary.get("object_type") == "PAYLOAD":
        return primary, secondary, "primary"
    if secondary.get("object_type") == "PAYLOAD":
        return secondary, primary, "secondary"
    return None


def _brief(e: dict) -> dict:
    return {"norad": e["norad"], "name": e["name"], "object_type": e["object_type"], "type_source": e.get("type_source")}


# --------------------------------------------------------------------------- planning


def plan(
    index: risk.CatalogIndex,
    primary_entry: dict,
    secondary_entry: dict,
    tca_utc: datetime,
    *,
    target_pc: float = DEFAULT_TARGET_PC,
    hbr_m: float = 20.0,
    now: datetime | None = None,
) -> dict:
    """Plan an avoidance burn. Results are cached per (objects, element sets, TCA, target, HBR) for 15 min."""
    now = now or datetime.now(timezone.utc)
    pick = choose_maneuvering(primary_entry, secondary_entry)
    if pick is None:
        return {
            "possible": False,
            "reason": "No manoeuvre possible: neither object can manoeuvre.",
            "primary": _brief(primary_entry),
            "secondary": _brief(secondary_entry),
            "assumptions": ASSUMPTIONS[:1],
        }
    m_e, o_e, role = pick
    key = (m_e["norad"], o_e["norad"], _iso(tca_utc), float(target_pc), float(hbr_m), m_e["tle1"], o_e["tle1"])
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL_S:
            return {**hit[1], "cached": True}
    result = _plan(index, m_e, o_e, role, tca_utc, target_pc, hbr_m, now)
    result["primary"] = _brief(primary_entry)
    result["secondary"] = _brief(secondary_entry)
    with _cache_lock:
        _cache[key] = (time.time(), result)
    return {**result, "cached": False}


def _plan(index, m_e: dict, o_e: dict, role: str, tca_given: datetime, target_pc: float, hbr_m: float, now: datetime) -> dict:
    t_start = time.perf_counter()
    hbr_km = hbr_m / 1000.0
    m = Satrec.twoline2rv(m_e["tle1"], m_e["tle2"])
    o = Satrec.twoline2rv(o_e["tle1"], o_e["tle2"])

    # Re-find the closest approach (SGP4, 1 s + sub-second polish) and the baseline risk.
    ref = risk._refine(m, o, tca_given, 0.0, -120.0, 120.0)
    if ref is None:
        raise ValueError("SGP4 cannot propagate these objects around the given TCA.")
    tca_off, miss0, _, vrel0, _, _ = ref
    tca = (tca_given + timedelta(seconds=tca_off)).replace(microsecond=0)
    jw, jf = risk._jd(tca, np.array([0.0]))
    tca_jd = float(jw[0] + jf[0])
    sig = math.hypot(
        risk.sigma_km(tca_jd - (m.jdsatepoch + m.jdsatepochF)),
        risk.sigma_km(tca_jd - (o.jdsatepoch + o.jdsatepochF)),
    )
    pc0 = risk.collision_probability(miss0, sig, hbr_km)
    period_s = 2.0 * math.pi / m.no_kozai * 60.0

    # Both objects around TCA (SGP4), shared by every candidate.
    w = np.arange(-TCA_WINDOW_S, TCA_WINDOW_S + 1, 1.0)
    i0 = TCA_WINDOW_S
    em, rm, vm = _sgp4_at(m, tca, w)
    eo, ro, vo = _sgp4_at(o, tca, w)
    bad = (em != 0) | (eo != 0)
    t_hat_tca = _rtn(rm[i0], vm[i0])[1]

    burn_times = []
    candidates: list[dict] = []
    solutions: dict[float, dict] = {}
    for nb in ORBITS_BEFORE:
        lead = nb * period_s
        tb = tca - timedelta(seconds=lead)
        reason = None
        if (tb - now).total_seconds() < MIN_BURN_AFTER_NOW_S:
            reason = "less than 1 h from now"
        elif lead > MAX_LEAD_S:
            reason = "more than 72 h before TCA"
        burn_times.append({"orbits_before": nb, "burn_utc": _iso(tb), "lead_h": round(lead / 3600.0, 2), "feasible": reason is None, "reason": reason})
        if reason:
            continue

        e_b, r_b, v_b = _sgp4_at(m, tb, np.array([0.0]))
        if e_b[0] != 0:
            burn_times[-1].update(feasible=False, reason="SGP4 failed at burn time")
            continue
        basis = _rtn(r_b[0], v_b[0])
        combos = [(d, mag) for d in DIRECTIONS for mag in DV_GRID_MS]
        dvs = np.array([np.asarray(d[2]) @ basis * (mag / 1000.0) for d, mag in combos])
        duration = lead + GRID_AFTER_TCA_S
        sol = _propagate(r_b[0], v_b[0], dvs, duration)
        solutions[nb] = {"tb": tb, "lead": lead, "sol": sol, "duration": duration, "r0": r_b[0], "v0": v_b[0], "dvs": dvs, "combos": combos}

        dr, dv = _deltas(sol, lead + w, duration)  # (150, nw, 3)
        rel = ro[None] - (rm[None] + dr)
        dist = np.linalg.norm(rel, axis=2)
        dist[:, bad] = np.inf
        j = np.argmin(dist, axis=1)
        for k, ((dkey, dlabel, _), mag) in enumerate(combos):
            jk = int(j[k])
            if not np.isfinite(dist[k, jk]):
                continue
            rel_j = rel[k, jk]
            vrel_j = vo[jk] - (vm[jk] + dv[k, jk])
            tau = float(np.clip(-np.dot(rel_j, vrel_j) / max(np.dot(vrel_j, vrel_j), 1e-12), -1.0, 1.0))
            miss = float(np.linalg.norm(rel_j + vrel_j * tau))
            new_pc = risk.collision_probability(miss, sig, hbr_km)
            shift = dr[k, i0]  # burn-induced position change at the original TCA
            candidates.append(
                {
                    "id": f"{nb:g}orb{dkey}{mag:.4f}",
                    "direction": dkey,
                    "direction_label": dlabel,
                    "dv_ms": float(mag),
                    "orbits_before": nb,
                    "burn_utc": _iso(tb),
                    "lead_h": round(lead / 3600.0, 3),
                    "new_miss_km": round(miss, 4),
                    "new_pc": new_pc,
                    "new_tca_utc": _iso(tca + timedelta(seconds=float(w[jk]) + tau)),
                    "tca_shift_s": round(float(w[jk]) + tau, 2),
                    "tca_window_edge": jk in (0, len(w) - 1),
                    "meets_target": new_pc < target_pc,
                    "along_track_shift_km": round(float(np.dot(shift, t_hat_tca)), 4),
                    "total_shift_km": round(float(np.linalg.norm(shift)), 4),
                    "rule_3dvt_km": round(3.0 * mag / 1000.0 * lead, 4),
                    "constraint": "not_checked",
                }
            )
    t_grid = time.perf_counter() - t_start
    try:
        lead_curve = _lead_curve(m, tca, ro[i0] - rm[i0], vo[i0] - vm[i0], sig, hbr_km, target_pc, now, period_s)
    except (RuntimeError, ValueError) as e:
        lead_curve = {"points": [], "note": f"Lead-time curve unavailable: {e}"}
    lead_curve["grid_points"] = _grid_min_dv(candidates, burn_times)

    base = {
        "possible": True,
        "maneuvering": {**_brief(m_e), "role": role},
        "other": _brief(o_e),
        "tca_utc": _iso(tca),
        "baseline": {"miss_km": round(miss0, 4), "pc": pc0, "sigma_km": round(sig, 3), "vrel_kms": round(float(np.linalg.norm(vrel0)), 3)},
        "target_pc": target_pc,
        "hbr_m": hbr_m,
        "burn_times": burn_times,
        "grid": {"directions": [d[0] for d in DIRECTIONS], "dv_ms": [float(x) for x in DV_GRID_MS], "orbits_before": list(ORBITS_BEFORE)},
        "assumptions": ASSUMPTIONS,
        "candidates": candidates,
        "recommended": None,
        "decision_deadline": None,
        "path": None,
        "constraint": None,
        "lead_curve": lead_curve,
    }

    if pc0 < target_pc:
        base["note"] = "Collision probability is already below the target; no manoeuvre needed."
        base["timing_s"] = {"grid": round(t_grid, 2), "constraint": 0.0, "total": round(time.perf_counter() - t_start, 2)}
        return base
    if not solutions:
        base["note"] = "No burn time is feasible: every option is under 1 h from now or over 72 h before TCA."
        base["timing_s"] = {"grid": round(t_grid, 2), "constraint": 0.0, "total": round(time.perf_counter() - t_start, 2)}
        return base

    meeting = sorted((c for c in candidates if c["meets_target"]), key=lambda c: (c["dv_ms"], c["lead_h"]))
    if not meeting:
        base["note"] = "No candidate in the grid (≤ 2 m/s, ≤ 3 orbits before TCA) reaches the target Pc."
        base["timing_s"] = {"grid": round(t_grid, 2), "constraint": 0.0, "total": round(time.perf_counter() - t_start, 2)}
        return base

    # Constraint batch: the cheapest target-meeting option at each burn time, then the cheapest overall.
    batch: list[dict] = []
    for nb in ORBITS_BEFORE:
        first = next((c for c in meeting if c["orbits_before"] == nb), None)
        if first:
            batch.append(first)
    for c in meeting:
        if len(batch) >= CONSTRAINT_BATCH:
            break
        if c not in batch:
            batch.append(c)

    t_c = time.perf_counter()
    t0c = min(solutions[c["orbits_before"]]["tb"] for c in batch)
    end = tca + timedelta(seconds=CONSTRAINT_AFTER_TCA_S)
    horizon = (end - t0c).total_seconds()
    perturbations: list = [None]
    for nb in sorted({c["orbits_before"] for c in batch}):
        s = solutions[nb]
        group = [c for c in batch if c["orbits_before"] == nb]
        dvs = np.array([s["dvs"][next(i for i, (d, mag) in enumerate(s["combos"]) if d[0] == c["direction"] and abs(mag - c["dv_ms"]) < 1e-12)] for c in group])
        dur = (end - s["tb"]).total_seconds()
        long_sol = _propagate(s["r0"], s["v0"], dvs, dur)
        offset = (s["tb"] - t0c).total_seconds()
        for gi, c in enumerate(group):
            c["_perturb"] = _make_perturb(long_sol, gi, offset, dur)
            c["_long"] = (long_sol, gi, offset, dur)
    ordered = list(batch)
    perturbations += [c["_perturb"] for c in ordered]
    events, co_located, sstats = risk.screen_paths(index, m_e, t0c, horizon, perturbations, CONSTRAINT_SCREEN_KM, hbr_m)

    def offending(evs: list[dict]) -> list[dict]:
        out = []
        for ev in evs:
            if ev["norad"] == o_e["norad"]:
                dt = abs((datetime.fromisoformat(ev["tca_utc"].replace("Z", "+00:00")) - tca).total_seconds())
                if dt <= AVOIDED_EVENT_WINDOW_S:
                    continue  # the encounter being avoided; judged by its residual Pc
            if ev["pc"] > NEW_CONJ_PC or ev["miss_km"] < NEW_CONJ_MISS_KM:
                out.append(ev)
        return out

    existing = offending(events[0])
    existing_ids = {ev["norad"] for ev in existing}
    for k, c in enumerate(ordered, start=1):
        new = [ev for ev in offending(events[k]) if ev["norad"] not in existing_ids]
        c["constraint"] = "rejected" if new else "passed"
        c["new_conjunctions"] = new[:5]
    t_constraint = time.perf_counter() - t_c

    passed = sorted((c for c in batch if c["constraint"] == "passed"), key=lambda c: (c["dv_ms"], c["lead_h"]))
    rec = passed[0] if passed else None
    base["constraint"] = {
        **sstats,
        "checked": len(batch),
        "passed": len(passed),
        "existing_conjunctions": existing[:5],
        "co_located_excluded_norads": co_located[:20],
        "window_end_utc": _iso(end),
    }
    if rec is None:
        base["note"] = "Every checked option creates a new conjunction; no recommendation."
    else:
        base["recommended"] = {k: v for k, v in rec.items() if not k.startswith("_")}
        base["path"] = _path(m, o, rec, solutions[rec["orbits_before"]], ro[i0])
        base["path"]["baseline_miss_km"] = round(miss0, 4)

    # Decision deadline: latest evaluated burn time with a valid (target-meeting, constraint-passing) option ≤ 1 m/s.
    for nb in ORBITS_BEFORE:  # ascending lead = latest burn first
        ok = [c for c in batch if c["orbits_before"] == nb and c["constraint"] == "passed" and c["dv_ms"] <= DEADLINE_MAX_DV_MS]
        if ok:
            c = min(ok, key=lambda x: x["dv_ms"])
            base["decision_deadline"] = {"burn_utc": c["burn_utc"], "lead_h": c["lead_h"], "orbits_before": nb, "dv_ms": c["dv_ms"], "direction": c["direction"]}
            break

    lead_curve["grid_points"] = _grid_min_dv(candidates, burn_times)  # now with constraint results
    for c in candidates:
        c.pop("_perturb", None)
        c.pop("_long", None)
    base["timing_s"] = {"grid": round(t_grid, 2), "constraint": round(t_constraint, 2), "total": round(time.perf_counter() - t_start, 2)}
    return base


def _make_perturb(sol, gi: int, offset_s: float, duration_s: float):
    """f(seconds from constraint window start) -> (dr, dv) of burned copy gi; zero before the burn."""

    def f(t: np.ndarray):
        t = np.asarray(t, dtype=float)
        s = t - offset_s
        dr, dv = _deltas(sol, s, duration_s)
        before = (s < 0)[:, None]
        return np.where(before, 0.0, dr[gi]), np.where(before, 0.0, dv[gi])

    return f


def _path(m: Satrec, o: Satrec, rec: dict, s: dict, other_at_tca: np.ndarray) -> dict:
    """Original vs post-burn positions of the manoeuvring object, and the other object's positions (TEME km),
    from the burn to TCA + 30 min every 30 s; plus the closest-approach points before and after the burn."""
    lead = s["lead"]
    t = np.arange(0.0, lead + PATH_AFTER_TCA_S + 1e-9, PATH_STEP_S)
    e, r, _ = _sgp4_at(m, s["tb"], t)
    eo, ro, _ = _sgp4_at(o, s["tb"], t)
    k = next(i for i, (d, mag) in enumerate(s["combos"]) if d[0] == rec["direction"] and abs(mag - rec["dv_ms"]) < 1e-12)
    dr, _ = _deltas(s["sol"], t, s["duration"])
    post = r + dr[k]
    ok = (e == 0) & (eo == 0)
    # Closest approach after the burn happens at the shifted TCA: burned-path and other-object positions there.
    t_tca = np.array([lead, lead + float(rec.get("tca_shift_s") or 0.0)])
    _, rt, _ = _sgp4_at(m, s["tb"], t_tca)
    _, ot, _ = _sgp4_at(o, s["tb"], t_tca)
    drt, _ = _deltas(s["sol"], t_tca, s["duration"])
    return {
        "start_utc": _iso(s["tb"]),
        "step_s": PATH_STEP_S,
        "original_km": np.round(r[ok], 3).tolist(),
        "burned_km": np.round(post[ok], 3).tolist(),
        "other_km": np.round(ro[ok], 3).tolist(),
        "burn_point_km": np.round(r[0], 3).tolist(),
        "tca_original_km": np.round(rt[0], 3).tolist(),
        "tca_burned_km": np.round(rt[1] + drt[k, 1], 3).tolist(),
        "other_at_tca_km": np.round(other_at_tca, 3).tolist(),
        "other_at_new_tca_km": np.round(ot[1], 3).tolist(),
        "dv_ms": rec["dv_ms"],
        "baseline_miss_km": None,  # set by the caller
        "new_miss_km": rec["new_miss_km"],
        "frame": "TEME (SGP4 inertial frame), km",
    }


# --------------------------------------------------------------------------- lead-time curve (est.)


def required_miss_km(sigma: float, hbr_km: float, target_pc: float) -> float | None:
    """Smallest miss distance with Pc ≤ target (Pc falls monotonically with miss at fixed σ). None = any miss works."""

    def f(d: float) -> float:
        return risk.collision_probability(d, sigma, hbr_km) - target_pc

    if f(0.0) <= 0:
        return None
    hi = max(sigma, hbr_km) * 4.0
    while f(hi) > 0:
        hi *= 2.0
        if hi > 1e5:
            raise ValueError("target Pc unreachable")
    return float(brentq(f, 0.0, hi, xtol=1e-7))


def _stm_backward(r_tca: np.ndarray, v_tca: np.ndarray, duration_s: float):
    """Reference orbit + 6 finite-difference copies (δr, δv) integrated BACKWARD from TCA (two-body + J2).

    Returns f(s) -> (Φ(TCA, TCA − s), reference state at TCA − s). Gravity (incl. J2) is Hamiltonian, so the STM is
    symplectic and Φ(TCA, t) = Φ(t, TCA)⁻¹ = −J·Φ(t, TCA)ᵀ·J exactly: no numerical inversion (which would amplify
    finite-difference errors over several orbits).
    """
    pert = np.zeros((6, 6))
    pert[:3, :3] = np.eye(3) * STM_DR_KM
    pert[3:, 3:] = np.eye(3) * STM_DV_KMS
    y0 = np.tile(np.concatenate([r_tca, v_tca]), (7, 1))
    y0[1:] += pert
    sol = solve_ivp(_rhs, (0.0, -duration_s), y0.ravel(), method="DOP853", rtol=RTOL, atol=ATOL, dense_output=True)
    if not sol.success:
        raise RuntimeError(f"orbit integration failed: {sol.message}")
    scale = np.array([STM_DR_KM] * 3 + [STM_DV_KMS] * 3)
    J = np.block([[np.zeros((3, 3)), np.eye(3)], [-np.eye(3), np.zeros((3, 3))]])

    def f(lead_s: float) -> tuple[np.ndarray, np.ndarray]:
        y = sol.sol(-lead_s).reshape(7, 6)
        phi_back = (y[1:] - y[0]).T / scale  # Φ(TCA − s, TCA)
        return -J @ phi_back.T @ J, y[0]

    return f


def _lead_curve(m: Satrec, tca: datetime, rel0: np.ndarray, vrel0: np.ndarray, sigma: float, hbr_km: float,
                target_pc: float, now: datetime, period_s: float) -> dict:
    """Minimum Δv (best of ±T/±R/±N) that brings Pc to the target, vs burn lead time (est., linearised).

    rel0 = other − manoeuvring position at TCA, vrel0 = other − manoeuvring velocity (TEME, km and km/s).
    """
    method = ("Linearised: Δr(TCA) = Φrv(TCA, burn)·Δv from a two-body + J2 state-transition matrix; new miss = "
              "|P(rel − Δr)| with P projecting onto the plane ⟂ relative velocity; best of ±along-track, ±radial, ±cross-track.")
    d_req = required_miss_km(sigma, hbr_km, target_pc)
    out: dict = {"points": [], "required_miss_km": None if d_req is None else round(d_req, 4), "method": method,
                 "max_orbits": LEAD_CURVE_MAX_ORBITS, "period_min": round(period_s / 60.0, 2)}
    vn = float(np.linalg.norm(vrel0))
    if d_req is None:
        out["note"] = "Pc is below the target at any miss distance; no burn needed."
        return out
    if vn < LEAD_CURVE_MIN_VREL_KMS:
        out["note"] = f"Relative velocity {vn * 1000:.0f} m/s is too low for the straight-line encounter model."
        return out
    max_lead = min(LEAD_CURVE_MAX_ORBITS * period_s, MAX_LEAD_S, (tca - now).total_seconds() - MIN_BURN_AFTER_NOW_S)
    min_lead = LEAD_CURVE_MIN_ORBITS * period_s
    if max_lead <= min_lead:
        out["note"] = "Too close to TCA for a lead-time curve."
        return out
    t0 = tca - timedelta(seconds=max_lead)
    e0, r0, v0 = _sgp4_at(m, tca, np.array([0.0]))
    if e0[0] != 0:
        raise RuntimeError("SGP4 failed at TCA")
    phi = _stm_backward(r0[0], v0[0], max_lead)
    vh = vrel0 / vn
    proj = np.eye(3) - np.outer(vh, vh)
    b0 = proj @ rel0
    b0n2 = float(b0 @ b0)
    for lead in np.linspace(min_lead, max_lead, LEAD_CURVE_POINTS):
        phi_cb, yb = phi(float(lead))  # Φ(TCA, burn) and the state at the burn
        basis = _rtn(yb[:3], yb[3:])
        best = None
        for dkey, _label, unit in DIRECTIONS:
            u = -(proj @ phi_cb[:3, 3:] @ (np.asarray(unit) @ basis)) / 1000.0  # km of miss vector per m/s
            uu = float(u @ u)
            if uu < 1e-18:
                continue
            bu = float(b0 @ u)
            # smallest s ≥ 0 with |b0 + s·u| = d_req (constant term < 0, so exactly one positive root)
            s_ms = 0.0 if b0n2 >= d_req * d_req else (-bu + math.sqrt(max(bu * bu - uu * (b0n2 - d_req * d_req), 0.0))) / uu
            if best is None or s_ms < best[0]:
                best = (s_ms, dkey)
        if best is None:
            continue
        out["points"].append({"lead_h": round(float(lead) / 3600.0, 4), "orbits_before": round(float(lead) / period_s, 3),
                              "burn_utc": _iso(tca - timedelta(seconds=float(lead))), "dv_ms": best[0], "direction": best[1]})
    out["earliest_burn_utc"] = _iso(t0)
    return out


def _grid_min_dv(candidates: list[dict], burn_times: list[dict]) -> list[dict]:
    """Non-linear grid: the cheapest target-meeting option at each evaluated burn time (dots on the lead-time chart)."""
    out = []
    for bt in burn_times:
        if not bt["feasible"]:
            continue
        ok = [c for c in candidates if c["orbits_before"] == bt["orbits_before"] and c["meets_target"]]
        if not ok:
            out.append({"orbits_before": bt["orbits_before"], "lead_h": bt["lead_h"], "dv_ms": None})
            continue
        c = min(ok, key=lambda x: x["dv_ms"])
        out.append({"orbits_before": bt["orbits_before"], "lead_h": bt["lead_h"], "dv_ms": c["dv_ms"],
                    "direction": c["direction"], "constraint": c["constraint"]})
    return out


# --------------------------------------------------------------------------- fuel


def burn_fuel(dv_ms: float, mass_kg: float, isp_s: float) -> dict:
    """Avoidance burn + return-to-orbit burn (est.: equal Δv), rocket equation; the return burn starts from the
    mass left after the avoidance burn, so total = m0·(1 − exp(−2Δv / (Isp·g0)))."""
    avoid = propellant_kg(dv_ms, mass_kg, isp_s)
    ret = propellant_kg(dv_ms, mass_kg - avoid, isp_s)
    return {"avoid_dv_ms": dv_ms, "return_dv_ms": dv_ms, "total_dv_ms": 2.0 * dv_ms,
            "avoid_kg": avoid, "return_kg": ret, "total_kg": avoid + ret}


def with_fuel(result: dict, mass_kg: float | None, isp_s: float | None, tank_kg: float | None = None,
              sk_ms_per_year: float | None = None) -> dict:
    """Add rocket-equation propellant figures for the given (or assumed) mass, Isp, tank size and station-keeping budget."""
    if not result.get("possible"):
        return result
    mass = mass_kg if mass_kg else DEFAULT_MASS_KG
    isp = isp_s if isp_s else DEFAULT_ISP_S
    tank = tank_kg if tank_kg else DEFAULT_TANK_FRACTION * mass
    sk = sk_ms_per_year if sk_ms_per_year else DEFAULT_SK_MS_PER_YEAR
    out = dict(result)
    out["inputs"] = {"mass_kg": mass, "isp_s": isp, "mass_assumed": not mass_kg, "isp_assumed": not isp_s,
                     "tank_kg": tank, "tank_assumed": not tank_kg,
                     "stationkeeping_ms_per_year": sk, "stationkeeping_assumed": not sk_ms_per_year}
    out["candidates"] = [{**c, "propellant_kg": propellant_kg(c["dv_ms"], mass, isp)} for c in result.get("candidates", [])]
    if result.get("decision_deadline"):
        dd = result["decision_deadline"]
        out["decision_deadline"] = {**dd, "propellant_kg": propellant_kg(dd["dv_ms"], mass, isp),
                                    "total_kg": burn_fuel(dd["dv_ms"], mass, isp)["total_kg"]}

    pc0 = (result.get("baseline") or {}).get("pc")
    rec = result.get("recommended")
    fuel: dict = {
        "recommended": None,
        "options": [],
        "assumptions": [
            f"Spacecraft wet mass {mass:g} kg{' (assumed)' if not mass_kg else ''}; Isp {isp:g} s{' (assumed: hydrazine monopropellant)' if not isp_s else ''}.",
            "Propellant from the rocket equation m·(1 − exp(−Δv / (Isp·g0))), g0 = 9.80665 m/s²; impulsive burns.",
            "Return-to-orbit burn est.: same Δv as the avoidance burn, opposite direction, after the encounter; not simulated.",
            f"Tank capacity {tank:g} kg{' (assumed: 10 % of wet mass)' if not tank_kg else ''}.",
            f"Station-keeping budget {sk:g} m/s per year{' (assumed)' if not sk_ms_per_year else ''}; life cost = total Δv ÷ that budget.",
        ],
    }
    if rec:
        f = burn_fuel(rec["dv_ms"], mass, isp)
        f["tank_pct"] = 100.0 * f["total_kg"] / tank
        f["life_days"] = f["total_dv_ms"] / (sk / 365.25)
        out["recommended"] = {**rec, "propellant_kg": f["avoid_kg"], "return_kg": f["return_kg"], "total_kg": f["total_kg"]}
        fuel["recommended"] = f
    valid = sorted((c for c in out["candidates"] if c.get("constraint") == "passed" and c.get("meets_target")),
                   key=lambda c: (c["dv_ms"], c["lead_h"]))[:TOP_OPTIONS]
    for c in valid:
        f = burn_fuel(c["dv_ms"], mass, isp)
        total_g = f["total_kg"] * 1000.0
        fuel["options"].append({
            "id": c["id"], "direction": c["direction"], "direction_label": c["direction_label"], "burn_utc": c["burn_utc"],
            "lead_h": c["lead_h"], "orbits_before": c["orbits_before"], "dv_ms": c["dv_ms"],
            "avoid_kg": f["avoid_kg"], "total_kg": f["total_kg"],
            "pc_before": pc0, "pc_after": c["new_pc"], "new_miss_km": c["new_miss_km"],
            # Pc removed per gram of total propellant (avoid + return est.)
            "risk_reduction_per_g": (pc0 - c["new_pc"]) / total_g if pc0 is not None and total_g > 0 else None,
            "recommended": bool(rec and c["id"] == rec["id"]),
        })
    lc = result.get("lead_curve")
    if lc:
        out["lead_curve"] = {
            **lc,
            "points": [{**p, "avoid_kg": propellant_kg(p["dv_ms"], mass, isp), "total_kg": burn_fuel(p["dv_ms"], mass, isp)["total_kg"]}
                       for p in lc.get("points", [])],
            "grid_points": [{**g, "avoid_kg": propellant_kg(g["dv_ms"], mass, isp) if g.get("dv_ms") is not None else None}
                            for g in lc.get("grid_points", [])],
        }
    out["fuel"] = fuel
    return out
