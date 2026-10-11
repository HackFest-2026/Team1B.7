"""Launch fuel: propellant to put a payload into a circular orbit (first-order estimate, every figure est.).

Δv budget
  Ideal (energy-equivalent): v = sqrt(μ (2/Re − 1/r)), the surface speed whose specific orbital energy equals
  that of the circular orbit at r (vis-viva). A two-burn Hohmann ascent from the surface needs slightly more
  (reported as `hohmann_reference_kms`); the gravity + drag loss allowance (ASSUMED, default 1.5 km/s) covers it.
  Earth rotation (first order): v_rot = ω·Re·cos(lat) = 0.4651·cos(lat) km/s; launch azimuth from north
  sin β = cos i / cos(lat); bonus = v_rot·sin β (negative = penalty for retrograde orbits such as SSO).
  |cos i / cos(lat)| > 1 → the inclination cannot be reached by a direct ascent from that site.
  Total = ideal + losses − bonus.

Staging (Tsiolkovsky, equal Δv split, same Isp on every stage, structural fraction ε = structure / (structure + propellant)):
  per stage R = exp(Δv_i / (Isp·g0)); stage mass (propellant + structure) = mass above × (R − 1) / (1 − R·ε),
  computed from the top stage down. R·ε ≥ 1 → not feasible with these settings.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

MU = 398600.4418  # km^3/s^2
RE = 6378.137  # km, WGS-84 equatorial radius
OMEGA_E = 7.2921159e-5  # rad/s
V_ROT_EQ = OMEGA_E * RE  # 0.4651 km/s
G0 = 9.80665  # m/s^2

# Launch sites: the verified dataset (data_static/launch_sites.json; sources and coordinate checks per site).
SITES_FILE = Path(__file__).parent / "data_static" / "launch_sites.json"
_DATA = json.loads(SITES_FILE.read_text(encoding="utf-8"))
SITE_RECORDS = {s["id"]: s for s in _DATA["sites"]}
SITES = {s["id"]: {"name": s["name"], "short_name": s["short_name"], "lat_deg": s["lat"], "lon_deg": s["lon"], "country": s["country"],
                   "status": s["status"], "indian": s["indian"]} for s in _DATA["sites"]}
# Keys used before the dataset existed.
SITE_ALIASES = {"sriharikota": "sdsc", "cape_canaveral": "ccsfs"}
# Typical vacuum-ish values, ASSUMED (real engines vary with expansion ratio and altitude).
PROPELLANTS = {
    "solid": {"name": "Solid", "isp_s": 270.0},
    "kerolox": {"name": "Kerosene / LOX", "isp_s": 300.0},
    "hydrolox": {"name": "Hydrogen / LOX", "isp_s": 420.0},
}
DEFAULTS = {"site": "sdsc", "altitude_km": 500.0, "inclination_deg": 97.4, "payload_kg": 1000.0, "propellant": "kerolox",
            "stages": 2, "structural_fraction": 0.08, "losses_kms": 1.5}
SWEEP_ALT_KM = list(range(300, 2001, 50))

ASSUMPTIONS = [
    "Ideal Δv is energy-equivalent (vis-viva at the surface); a two-burn Hohmann ascent needs slightly more (shown for reference).",
    "Gravity + drag losses are an assumed allowance, not simulated (real ascents: roughly 1.3–2 km/s).",
    "Earth-rotation gain is first order: v_rot·sin β along the launch azimuth; no dogleg, range-safety or plane-change manoeuvres.",
    "At a fixed inclination that gain equals ω·Re·cos i from every site that can reach it; a low-latitude site helps by reaching lower inclinations (due east) and by avoiding plane changes.",
    "Δv split equally between stages, one Isp for every stage (typical value, assumed); structural fraction ε = structure ÷ (structure + propellant), assumed.",
    "No fairing, interstage, adapter, residual propellant or engine-out margins.",
]


class LaunchInputError(ValueError):
    pass


def ideal_dv_kms(alt_km: float) -> float:
    r = RE + alt_km
    return math.sqrt(MU * (2.0 / RE - 1.0 / r))


def hohmann_from_surface_kms(alt_km: float) -> float:
    """Non-rotating two-burn reference: surface (perigee) → circular orbit at r (for comparison only)."""
    r = RE + alt_km
    a = (RE + r) / 2.0
    v_p = math.sqrt(MU * (2.0 / RE - 1.0 / a))
    v_a = math.sqrt(MU * (2.0 / r - 1.0 / a))
    return v_p + (math.sqrt(MU / r) - v_a)


def rotation(lat_deg: float, inc_deg: float) -> dict:
    """Launch azimuth and Earth-rotation gain (km/s); reachable False if the inclination cannot be flown directly."""
    v_rot = V_ROT_EQ * math.cos(math.radians(lat_deg))
    ratio = math.cos(math.radians(inc_deg)) / math.cos(math.radians(lat_deg))
    if abs(ratio) > 1.0 + 1e-12:
        lo = abs(lat_deg)
        return {"reachable": False, "v_rot_kms": v_rot, "ratio": ratio,
                "reason": f"{inc_deg:g}° cannot be reached by a direct ascent from latitude {lat_deg:g}°: "
                          f"direct inclinations span {lo:g}°–{180 - lo:g}° (needs a plane change or dogleg, not modelled)."}
    ratio = max(-1.0, min(1.0, ratio))
    beta = math.degrees(math.asin(ratio))
    return {"reachable": True, "v_rot_kms": v_rot, "ratio": ratio, "azimuth_deg": beta, "azimuth_alt_deg": 180.0 - beta,
            "bonus_kms": v_rot * ratio}


def stages(total_dv_kms: float, payload_kg: float, isp_s: float, n: int, eps: float) -> dict:
    """Equal-Δv staging from the top down. Returns per-stage masses or feasible=False."""
    dv_i = total_dv_kms * 1000.0 / n
    R = math.exp(dv_i / (isp_s * G0))
    if R * eps >= 1.0:
        return {"feasible": False, "mass_ratio": R,
                "reason": f"Not feasible with these settings: each stage needs mass ratio {R:.2f}, but structure at "
                          f"ε = {eps:g} caps it below {1 / eps:.2f} (R·ε ≥ 1). Add stages, raise Isp or lower ε."}
    above = payload_kg
    out = []
    for k in range(n, 0, -1):  # top stage first
        m_stage = above * (R - 1.0) / (1.0 - R * eps)
        prop = (1.0 - eps) * m_stage
        out.append({"stage": k, "dv_kms": dv_i / 1000.0, "mass_ratio": R, "propellant_kg": prop, "structure_kg": eps * m_stage,
                    "stage_mass_kg": m_stage, "mass_above_kg": above, "ignition_mass_kg": above + m_stage})
        above += m_stage
    out.reverse()  # stage 1 first
    prop_total = sum(s["propellant_kg"] for s in out)
    return {"feasible": True, "mass_ratio": R, "stages": out, "gross_liftoff_kg": above, "propellant_total_kg": prop_total,
            "structure_total_kg": sum(s["structure_kg"] for s in out),
            "propellant_per_kg_payload": prop_total / payload_kg, "payload_fraction_pct": 100.0 * payload_kg / above}


def budget(lat_deg: float, alt_km: float, inc_deg: float, losses_kms: float) -> dict:
    rot = rotation(lat_deg, inc_deg)
    ideal = ideal_dv_kms(alt_km)
    b = {"ideal_kms": ideal, "hohmann_reference_kms": hohmann_from_surface_kms(alt_km), "losses_kms": losses_kms,
         "rotation": rot, "reachable": rot["reachable"]}
    if rot["reachable"]:
        b["rotation_bonus_kms"] = rot["bonus_kms"]
        b["total_kms"] = ideal + losses_kms - rot["bonus_kms"]
    return b


def compute(lat_deg: float, alt_km: float, inc_deg: float, payload_kg: float, isp_s: float, n_stages: int, eps: float,
            losses_kms: float) -> dict:
    b = budget(lat_deg, alt_km, inc_deg, losses_kms)
    if not b["reachable"]:
        return {"budget": b, "feasible": False, "reason": b["rotation"]["reason"]}
    st = stages(b["total_kms"], payload_kg, isp_s, n_stages, eps)
    return {"budget": b, **st}


def _validate(alt_km, inc_deg, payload_kg, isp_s, n, eps, losses, lat):
    if not (100 <= alt_km <= 40000):
        raise LaunchInputError("Altitude must be 100–40,000 km.")
    if not (0 <= inc_deg <= 180):
        raise LaunchInputError("Inclination must be 0–180°.")
    if not (0 < payload_kg <= 1e6):
        raise LaunchInputError("Payload mass must be 0–1,000,000 kg.")
    if not (50 <= isp_s <= 1000):
        raise LaunchInputError("Isp must be 50–1,000 s.")
    if n not in (1, 2, 3, 4):
        raise LaunchInputError("Stages must be 1–4.")
    if not (0 < eps < 1):
        raise LaunchInputError("Structural fraction must be between 0 and 1.")
    if not (0 <= losses <= 5):
        raise LaunchInputError("Loss allowance must be 0–5 km/s.")
    if not (-90 < lat < 90):
        raise LaunchInputError("Latitude must be between −90° and 90°.")


def launch_fuel(*, site: str | None, lat_deg: float | None, altitude_km: float, inclination_deg: float, payload_kg: float,
                propellant: str | None, isp_s: float | None, stages_n: int, structural_fraction: float, losses_kms: float) -> dict:
    """Full answer for the Fuel tab: the selected case, all four preset sites, and an altitude sweep."""
    site = SITE_ALIASES.get(site or "", site)
    if lat_deg is None:
        if site not in SITES:
            raise LaunchInputError(f"Unknown site; use one of {', '.join(SITES)} or give lat_deg.")
        lat, site_name = SITES[site]["lat_deg"], SITES[site]["name"]
    else:
        lat, site_name = lat_deg, f"Custom ({lat_deg:g}°)"
    if isp_s is None:
        if propellant not in PROPELLANTS:
            raise LaunchInputError(f"Unknown propellant; use one of {', '.join(PROPELLANTS)} or give isp_s.")
        isp, prop_name = PROPELLANTS[propellant]["isp_s"], PROPELLANTS[propellant]["name"]
    else:
        isp, prop_name = isp_s, "Custom Isp"
    _validate(altitude_km, inclination_deg, payload_kg, isp, stages_n, structural_fraction, losses_kms, lat)

    args = dict(payload_kg=payload_kg, isp_s=isp, n_stages=stages_n, eps=structural_fraction, losses_kms=losses_kms)
    main = compute(lat, altitude_km, inclination_deg, **args)
    sites = []
    for key, s in SITES.items():
        r = compute(s["lat_deg"], altitude_km, inclination_deg, **args)
        east = compute(s["lat_deg"], altitude_km, abs(s["lat_deg"]), **args)  # due east: i = |latitude|, the most rotation gain
        sites.append({"key": key, "name": s["name"], "short_name": s["short_name"], "country": s["country"], "status": s["status"],
                      "indian": s["indian"], "lat_deg": s["lat_deg"], "min_inclination_deg": abs(s["lat_deg"]),
                      "reachable": r["budget"]["reachable"],
                      "feasible": r.get("feasible", False), "total_dv_kms": r["budget"].get("total_kms"),
                      "rotation_bonus_kms": r["budget"].get("rotation_bonus_kms"),
                      "propellant_per_kg_payload": r.get("propellant_per_kg_payload"),
                      "gross_liftoff_kg": r.get("gross_liftoff_kg"), "reason": r.get("reason"),
                      "due_east": {"inclination_deg": s["lat_deg"], "total_dv_kms": east["budget"]["total_kms"],
                                   "rotation_bonus_kms": east["budget"]["rotation_bonus_kms"],
                                   "propellant_per_kg_payload": east.get("propellant_per_kg_payload")}})
    _rank(sites)
    sweep = []
    for alt in SWEEP_ALT_KM:
        r = compute(lat, float(alt), inclination_deg, **args)
        sweep.append({"altitude_km": alt, "total_dv_kms": r["budget"].get("total_kms"),
                      "propellant_per_kg_payload": r.get("propellant_per_kg_payload") if r.get("feasible") else None})
    return {
        "inputs": {"site": site if lat_deg is None else "custom", "site_name": site_name, "lat_deg": lat, "altitude_km": altitude_km,
                   "inclination_deg": inclination_deg, "payload_kg": payload_kg, "propellant": propellant if isp_s is None else "custom",
                   "propellant_name": prop_name, "isp_s": isp, "isp_assumed": isp_s is None, "stages": stages_n,
                   "structural_fraction": structural_fraction, "losses_kms": losses_kms},
        "result": main,
        "sites": sites,
        "altitude_sweep": sweep,
        "constants": {"mu_km3_s2": MU, "re_km": RE, "v_rot_equator_kms": V_ROT_EQ, "g0_ms2": G0},
        "assumptions": ASSUMPTIONS,
    }


def _rank(sites: list[dict]) -> None:
    """Sort by propellant per kg of payload (lowest first); equal values share a rank (first order, every site that can
    reach the inclination gets the same rotation gain). Sites that cannot reach it directly, or are infeasible, go last
    with rank None. Ties are listed by |latitude|."""
    ok = [s for s in sites if s["propellant_per_kg_payload"] is not None]
    rest = [s for s in sites if s["propellant_per_kg_payload"] is None]
    ok.sort(key=lambda s: (round(s["propellant_per_kg_payload"], 6), abs(s["lat_deg"])))
    rest.sort(key=lambda s: abs(s["lat_deg"]))
    rank, prev = 0, None
    for i, s in enumerate(ok, start=1):
        v = round(s["propellant_per_kg_payload"], 6)
        if v != prev:
            rank, prev = i, v
        s["rank"] = rank
        s["tied"] = False
    counts: dict[int, int] = {}
    for s in ok:
        counts[s["rank"]] = counts.get(s["rank"], 0) + 1
    for s in ok:
        s["tied"] = counts[s["rank"]] > 1
    for s in rest:
        s["rank"] = None
        s["tied"] = False
    sites[:] = ok + rest


def site_list() -> dict:
    """GET /launch-sites: the dataset plus physics facts we compute (Earth-rotation speed, lowest direct inclination)."""
    out = []
    for s in _DATA["sites"]:
        lat = s["lat"]
        out.append({**s, "physics": {"v_rot_kms": V_ROT_EQ * math.cos(math.radians(lat)), "min_inclination_deg": abs(lat),
                                      "max_inclination_deg": 180.0 - abs(lat)}})
    return {"sites": out, "count": len(out), "countries": sorted({s["country"] for s in out}),
            "statuses": sorted({s["status"] for s in out}), "compiled_utc": _DATA.get("compiled_utc"), "note": _DATA.get("note"),
            "physics_note": "v_rot = 0.4651·cos(latitude) km/s (ω·Re); lowest inclination reachable by a direct launch = |latitude|."}


def presets() -> dict:
    return {"sites": SITES, "site_aliases": SITE_ALIASES, "propellants": PROPELLANTS, "defaults": DEFAULTS, "sweep_altitudes_km": [SWEEP_ALT_KM[0], SWEEP_ALT_KM[-1]],
            "assumptions": ASSUMPTIONS}
