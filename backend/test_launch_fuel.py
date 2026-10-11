"""Sanity checks for launch_fuel.py. Run: py -3.11 test_launch_fuel.py (or pytest if installed)."""
import math

import launch_fuel as lf

BASE = dict(payload_kg=1000.0, isp_s=300.0, n_stages=2, eps=0.08, losses_kms=1.5)


def test_dv_to_500km_is_realistic():
    # Typical LEO budgets are ~9.3–10 km/s including losses.
    for site in lf.SITES.values():
        b = lf.budget(site["lat_deg"], 500.0, max(51.6, abs(site["lat_deg"]) + 1.0), 1.5)
        assert 9.3 <= b["total_kms"] <= 10.0, (site, b["total_kms"])


def test_ideal_dv_value():
    # sqrt(398600.4418 * (2/6378.137 - 1/6878.137)) = 8.188 km/s
    assert math.isclose(lf.ideal_dv_kms(500.0), 8.1876, abs_tol=5e-4)
    # Hohmann from the surface costs a little more than the energy-equivalent figure.
    assert 0 < lf.hohmann_from_surface_kms(500.0) - lf.ideal_dv_kms(500.0) < 0.05


def test_equatorial_east_beats_high_latitude():
    # Due-east launches (i = site latitude) collect the most rotation; the equatorial site gets more.
    kourou = lf.compute(5.2, 500.0, 5.2, **BASE)
    baikonur = lf.compute(45.9, 500.0, 45.9, **BASE)
    assert math.isclose(kourou["budget"]["rotation_bonus_kms"], lf.V_ROT_EQ * math.cos(math.radians(5.2)), rel_tol=1e-9)
    assert kourou["budget"]["rotation_bonus_kms"] > baikonur["budget"]["rotation_bonus_kms"] + 0.1
    assert kourou["propellant_per_kg_payload"] < baikonur["propellant_per_kg_payload"]
    # First order, the gain at a fixed inclination is ω·Re·cos i from any site that can reach it.
    a = lf.compute(5.2, 500.0, 51.6, **BASE)["budget"]["rotation_bonus_kms"]
    b = lf.compute(45.9, 500.0, 51.6, **BASE)["budget"]["rotation_bonus_kms"]
    assert math.isclose(a, b, rel_tol=1e-9)


def test_sso_from_sriharikota_is_a_penalty():
    r = lf.compute(13.72, 500.0, 97.4, **BASE)
    assert r["budget"]["rotation_bonus_kms"] < 0
    assert r["budget"]["total_kms"] > r["budget"]["ideal_kms"] + 1.5


def test_unreachable_inclination():
    r = lf.compute(45.9, 500.0, 45.0, **BASE)  # Baikonur cannot fly 45° directly
    assert not r["budget"]["reachable"] and not r["feasible"]


def test_staging_mass_balance_and_infeasible():
    r = lf.compute(13.72, 500.0, 45.0, **BASE)
    st = r["stages"]
    # Each stage's mass ratio reproduces its Δv share.
    for s in st:
        mf = s["ignition_mass_kg"] - s["propellant_kg"]
        assert math.isclose(s["ignition_mass_kg"] / mf, s["mass_ratio"], rel_tol=1e-9)
        assert math.isclose(s["structure_kg"] / s["stage_mass_kg"], 0.08, rel_tol=1e-9)
    total_dv = sum(lf.G0 * 300.0 * math.log(s["mass_ratio"]) for s in st) / 1000.0
    assert math.isclose(total_dv, r["budget"]["total_kms"], rel_tol=1e-9)
    assert math.isclose(r["gross_liftoff_kg"], 1000.0 + sum(s["stage_mass_kg"] for s in st), rel_tol=1e-9)
    bad = lf.compute(13.72, 500.0, 45.0, payload_kg=1000.0, isp_s=270.0, n_stages=1, eps=0.08, losses_kms=1.5)
    assert bad["feasible"] is False and "Not feasible" in bad["reason"]


def test_dataset_and_ranking():
    d = lf.site_list()
    assert d["count"] == len(lf.SITES) >= 25
    ids = {s["id"] for s in d["sites"]}
    assert {"sdsc", "terls", "kulasekarapattinam"} <= ids
    for s in d["sites"]:
        assert -90 < s["lat"] < 90 and -180 <= s["lon"] <= 180 and s["source_url"].startswith("https://")
        assert s["status"] in ("operational", "under construction", "inactive")
        assert math.isclose(s["physics"]["v_rot_kms"], 0.4651 * math.cos(math.radians(s["lat"])), rel_tol=1e-3)
    r = lf.launch_fuel(site="sdsc", lat_deg=None, altitude_km=500, inclination_deg=51.6, payload_kg=1000, propellant="kerolox",
                       isp_s=None, stages_n=2, structural_fraction=0.08, losses_kms=1.5)
    by = {s["key"]: s for s in r["sites"]}
    assert by["plesetsk"]["rank"] is None and not by["plesetsk"]["reachable"]  # 62.9° N cannot fly 51.6° directly
    assert by["sdsc"]["rank"] == 1 and by["sdsc"]["tied"]
    assert lf.launch_fuel(site="sriharikota", lat_deg=None, altitude_km=500, inclination_deg=97.4, payload_kg=1000, propellant="kerolox",
                          isp_s=None, stages_n=2, structural_fraction=0.08, losses_kms=1.5)["inputs"]["site"] == "sdsc"  # old key


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("pass", name)
