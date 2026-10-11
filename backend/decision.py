"""Go / No-Go recommendation and plain-language explanation for each conjunction.

RECOMMENDATION ONLY: the operator decides. Nothing here (or anywhere in KesslerWatch) executes a manoeuvre.

Inputs per conjunction (a /screen record, see risk.conjunction_record + ml.score_conjunctions): physics Pc,
AI calibrated P(high-risk), AI predicted final risk, time to TCA, combined σ and both TLE ages, whether either
object can manoeuvre (PAYLOAD), and, once /avoid has run, the recommended Δv and decision deadline.

Two-stage logic (`triggers` is the single implementation, used live and for the ESA KPIs in ml.py):
  Stage 1  AI early flag     AI P(high-risk) ≥ the live model's 95%-recall threshold. A tag only: on its own the
                             decision stays NO-GO; Sentinel tracks it.
  Stage 2  Physics           GO — Manoeuvre     Pc ≥ go_pc or AI final risk ≥ go_ai_final_risk, and the planner
                                                found a valid option.
                             Cannot manoeuvre   GO thresholds met but neither object is a payload: monitor.
                             WATCH — Re-assess  Pc ≥ watch_pc; or AI flag and Pc ≥ watch_ai_min_pc; or a TLE older
                                                than tle_stale_days on an approach closer than stale_watch_miss_km;
                                                or GO thresholds met without a valid option.
                             NO-GO — Hold       none of the above.
  Sentinel guard (sentinel.py): CONFIRMED GO needs GO plus 2 consecutive data updates above the GO threshold, or
  Pc and AI final risk both at GO level; a stale TLE caps the status at WATCH.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone

import maneuver_opt
import ml
import risk

# Every threshold the decision uses. ai_p_high_threshold is filled from the trained live model at runtime
# (chosen on the validation split for >= 95% recall of high-risk events; see ml.operating_threshold).
CONFIG: dict = {
    "go_pc": 1e-4,
    "go_ai_final_risk": 1e-4,
    "watch_pc": 1e-5,  # WATCH on physics alone
    "watch_ai_min_pc": 1e-6,  # WATCH when the AI early flag is backed by at least this Pc
    "ai_p_high_threshold": None,  # AI early-flag threshold
    "tle_stale_days": 3.0,
    "stale_watch_miss_km": 5.0,  # stale data only raises WATCH on approaches closer than this
    "confirm_updates": 2,  # Sentinel: consecutive data updates above the GO threshold for CONFIRMED GO
    "confirm_ai_final_risk": 1e-4,  # Sentinel: or Pc ≥ go_pc AND AI final risk ≥ this (both methods agree)
    "avoid_target_pc": 1e-5,  # maneuver_opt.DEFAULT_TARGET_PC: a valid option must bring Pc below this
    "deadline_max_dv_ms": 1.0,  # maneuver_opt.DEADLINE_MAX_DV_MS
    "latest_burn_orbits_before_tca": 0.5,  # latest burn slot the planner evaluates (re-check time before a plan exists)
}

RANK = {"GO": 0, "MONITOR": 1, "WATCH": 2, "NO-GO": 3}
LABEL = {"GO": "GO — Manoeuvre", "MONITOR": "Cannot manoeuvre — monitor", "WATCH": "WATCH — Re-assess", "NO-GO": "NO-GO — Hold"}
EARLY_FLAG_TAG = "AI early flag"
STALE_TAG = "stale data"
OPERATOR_NOTE = "Recommendation — operator decides. Never auto-executed."


def config() -> dict:
    return {**CONFIG, "ai_p_high_threshold": ml.live_threshold()}


def rules() -> dict:
    """The decision rules as shown in the UI under "Decision rules"."""
    c = config()
    thr = c["ai_p_high_threshold"]
    thr_txt = f"{thr:.2%}" if thr is not None else "n/a (model not trained)"
    return {
        "config": c,
        "stages": [
            {"stage": 1, "title": "AI early flag", "when": f"AI P(high-risk) ≥ {thr_txt} (chosen on validation to catch ≥ 95% of high-risk events). A tag only: on its own the decision stays NO-GO, and Sentinel keeps tracking it."},
            {"stage": 2, "title": "Physics confirmation", "when": f"WATCH needs Pc ≥ {_sci(c['watch_pc'])}, or the AI flag backed by Pc ≥ {_sci(c['watch_ai_min_pc'])}, or a TLE older than {c['tle_stale_days']:g} d on an approach closer than {c['stale_watch_miss_km']:g} km. GO needs Pc ≥ {_sci(c['go_pc'])} or AI final risk ≥ {_sci(c['go_ai_final_risk'])}, and a valid avoidance option."},
            {"stage": 3, "title": "Sentinel false-alert guard", "when": f"CONFIRMED GO only if the decision is GO and either the GO threshold held on {c['confirm_updates']} consecutive data updates, or Pc ≥ {_sci(c['go_pc'])} and AI final risk ≥ {_sci(c['confirm_ai_final_risk'])} independently. A TLE older than {c['tle_stale_days']:g} d caps the status at WATCH."},
        ],
        "rules": [
            {"decision": "GO", "label": LABEL["GO"], "when": f"Pc ≥ {_sci(c['go_pc'])} or AI-predicted final risk ≥ {_sci(c['go_ai_final_risk'])}, and the avoidance planner found a valid option (Pc < {_sci(c['avoid_target_pc'])}, no new conjunction)."},
            {"decision": "MONITOR", "label": LABEL["MONITOR"], "when": "GO thresholds met, but neither object is a payload, so nothing can manoeuvre."},
            {"decision": "WATCH", "label": LABEL["WATCH"], "when": f"Pc ≥ {_sci(c['watch_pc'])}; or AI P(high-risk) ≥ {thr_txt} and Pc ≥ {_sci(c['watch_ai_min_pc'])}; or a TLE older than {c['tle_stale_days']:g} d with miss < {c['stale_watch_miss_km']:g} km; or GO thresholds met but no valid option found. Re-check before the decision deadline."},
            {"decision": "NO-GO", "label": LABEL["NO-GO"], "when": f"Below all thresholds. An AI flag alone stays NO-GO, tagged \u201c{EARLY_FLAG_TAG}\u201d."},
        ],
        "deadline": f"Decision deadline: from the avoidance plan, the latest evaluated burn time with a checked option ≤ {c['deadline_max_dv_ms']:g} m/s. Before a plan exists: the latest burn slot the planner evaluates ({c['latest_burn_orbits_before_tca']:g} orbit before TCA).",
        "ai_note": "AI rules use the live model's estimates; the model was trained on conjunctions 2–7 days out, so closer TCAs are outside its training range (flagged).",
        "note": OPERATOR_NOTE,
    }


def can_manoeuvre(c: dict) -> bool:
    """Same rule as maneuver_opt.choose_maneuvering: only PAYLOAD objects are assumed to have propulsion."""
    return c.get("primary_object_type") == "PAYLOAD" or c.get("object_type") == "PAYLOAD"


def _sci(x: float) -> str:
    return f"{x:.1e}".replace(".0e", "e").replace("e-0", "e−").replace("e-", "e−")


def _pct(p: float) -> str:
    return "< 0.1%" if p < 0.001 else f"{p * 100:.1f}%" if p < 0.1 else f"{p * 100:.0f}%"


def _age(h: float) -> str:
    return f"{h:.0f} h" if h < 48 else f"{h / 24:.1f} d"


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def triggers(pc: float, ai_p: float | None, ai_risk: float | None, oldest_h: float | None, miss_km: float | None,
             cfg: dict | None = None, ood: str = "") -> dict:
    """The two-stage rule for one conjunction: GO and WATCH reasons, the AI early flag and staleness.

    The single implementation of the thresholds, used by `evaluate` (live) and by ml.decision_level_kpis (ESA data).
    """
    cfg = cfg or config()
    thr = cfg["ai_p_high_threshold"]
    ai_flag = ai_p is not None and thr is not None and ai_p >= thr
    stale = oldest_h is not None and oldest_h > cfg["tle_stale_days"] * 24

    go: list[str] = []
    if pc >= cfg["go_pc"]:
        go.append(f"Pc {_sci(pc)} ≥ {_sci(cfg['go_pc'])}")
    if ai_risk is not None and ai_risk >= cfg["go_ai_final_risk"]:
        go.append(f"AI-predicted final risk {_sci(ai_risk)} ≥ {_sci(cfg['go_ai_final_risk'])}{ood}")

    watch: list[str] = []
    if cfg["watch_pc"] <= pc < cfg["go_pc"]:
        watch.append(f"Pc {_sci(pc)} between {_sci(cfg['watch_pc'])} and {_sci(cfg['go_pc'])}")
    if ai_flag and cfg["watch_ai_min_pc"] <= pc < cfg["watch_pc"]:
        watch.append(f"AI early flag ({_pct(ai_p)} chance of ending high-risk ≥ {thr:.2%}){ood}, backed by Pc {_sci(pc)} ≥ {_sci(cfg['watch_ai_min_pc'])}")
    if stale and miss_km is not None and miss_km < cfg["stale_watch_miss_km"]:
        watch.append(f"TLE {_age(oldest_h)} old (> {cfg['tle_stale_days']:g} d) on an approach of {miss_km:.2f} km (< {cfg['stale_watch_miss_km']:g} km)")
    return {"go": go, "watch": watch, "ai_flag": ai_flag, "stale": stale}


def evaluate(c: dict, plan: dict | None = None, now: datetime | None = None, period_s: float | None = None) -> dict:
    """Decision for one conjunction. `plan` is the /avoid result for it (None if not run yet).
    `period_s` is the orbital period of the object that would manoeuvre (for the re-check time before a plan exists)."""
    cfg = config()
    now = now or datetime.now(timezone.utc)
    tca = datetime.fromisoformat(c["tca_utc"].replace("Z", "+00:00"))
    pc = float(c["pc"])
    ai_p = c.get("ai_p_high")
    ai_risk = 10.0 ** c["ai_log10_risk"] if c.get("ai_log10_risk") is not None else None
    ood = "" if c.get("ai_in_domain", True) else " (AI outside its 2–7 d training range)"
    ages = [a for a in (c.get("primary_tle_age_h"), c.get("secondary_tle_age_h")) if a is not None]
    oldest_h = max(ages) if ages else None

    t = triggers(pc, ai_p, ai_risk, oldest_h, c.get("miss_km"), cfg, ood)
    go, watch, ai_flag = t["go"], t["watch"], t["ai_flag"]

    movable = can_manoeuvre(c) if plan is None else bool(plan.get("possible"))
    recommended = None
    provisional = False
    if go:
        reasons = go + watch
        if not movable:
            decision, headline = "MONITOR", "High risk, but neither object can manoeuvre. Monitor and coordinate."
        elif plan is None:
            decision, provisional = "GO", True
            headline = "GO thresholds met. Open this alert to run the avoidance planner and confirm a valid option."
        elif plan.get("recommended"):
            r = plan["recommended"]
            decision = "GO"
            recommended = {k: r.get(k) for k in ("dv_ms", "direction", "direction_label", "burn_utc", "lead_h", "new_pc", "new_miss_km", "propellant_kg")}
            headline = f"Valid option: {r['dv_ms']:.3g} m/s {r['direction_label'].lower()} at {r['burn_utc'][5:16].replace('T', ' ')} UTC (est.)."
        else:
            decision = "WATCH"
            note = plan.get("note") or "the planner found no valid option"
            reasons = reasons + [f"GO thresholds met, but no valid avoidance option: {note}"]
            headline = "High risk without a valid avoidance option in the grid. Re-assess with fresh orbit data."
    elif watch:
        decision, reasons, headline = "WATCH", watch, "Not actionable yet. Re-assess with fresh orbit data before the deadline."
    elif ai_flag:
        decision = "NO-GO"
        reasons = [f"{EARLY_FLAG_TAG}: AI gives {_pct(ai_p)} chance of ending high-risk (≥ {cfg['ai_p_high_threshold']:.2%}){ood}, "
                   f"but Pc {_sci(pc)} < {_sci(cfg['watch_ai_min_pc'])}, so physics does not confirm it"]
        headline = "Below WATCH thresholds. AI early flag: tracked by Sentinel, not actionable on its own."
    else:
        decision, reasons, headline = "NO-GO", [f"Pc {_sci(pc)} < {_sci(cfg['watch_pc'])}; no other trigger"], "Below all thresholds. Hold."

    recheck = None
    if decision != "NO-GO":
        dl = (plan or {}).get("decision_deadline")
        if dl:
            recheck = {"utc": dl["burn_utc"], "basis": "decision deadline from the avoidance plan"}
        elif period_s:
            slot = tca - timedelta(seconds=cfg["latest_burn_orbits_before_tca"] * period_s)
            recheck = {"utc": _iso(slot), "basis": f"latest burn slot ({cfg['latest_burn_orbits_before_tca']:g} orbit before TCA){'' if plan else '; no avoidance plan yet'}",
                       "passed": slot <= now}
        else:
            recheck = {"utc": c["tca_utc"], "basis": "TCA (no burn slot available)"}

    return {
        "decision": decision,
        "label": LABEL[decision],
        "rank": RANK[decision],
        "headline": headline,
        "reasons": reasons,
        "provisional": provisional,
        "can_manoeuvre": movable,
        "recommended": recommended,
        "recheck_before": recheck,
        "hours_to_tca": round((tca - now).total_seconds() / 3600.0, 2),
        "ai_flag": ai_flag,
        "early_flag": ai_flag and decision == "NO-GO",
        "stale": t["stale"],
        "tags": ([EARLY_FLAG_TAG] if ai_flag and decision == "NO-GO" else []) + ([STALE_TAG] if t["stale"] else []),
        "note": OPERATOR_NOTE,
    }


def explain(c: dict) -> dict:
    """3 physical factors + the AI line. Each physical factor's bar is its AI contribution: how much it moves the
    AI probability compared with a typical ESA event (the input set to its training median). The AI bar is the
    probability itself."""
    contrib = c.get("ai_contributions") or {}
    ages = [a for a in (c.get("primary_tle_age_h"), c.get("secondary_tle_age_h")) if a is not None]
    age_txt = f" (TLE {_age(max(ages))} old)" if ages else ""
    radial = c.get("radial_km")
    physical = [
        {"key": "miss", "text": f"Miss distance {c['miss_km']:.2f} km", "contribution": contrib.get("miss")},
        {"key": "radial", "text": f"Radial separation {abs(radial):.2f} km" if radial is not None else "Radial separation unavailable", "contribution": contrib.get("radial")},
        {"key": "uncertainty", "text": f"Uncertainty {c['sigma_km']:.1f} km{age_txt}", "contribution": contrib.get("uncertainty")},
    ]
    scale = max([abs(f["contribution"]) for f in physical if f["contribution"] is not None] + [0.05])
    for f in physical:
        v = f["contribution"]
        f["bar"] = None if v is None else round(min(abs(v) / scale, 1.0), 3)
        f["effect"] = None if v is None else "raises" if v > 5e-4 else "lowers" if v < -5e-4 else "neutral"
    physical.sort(key=lambda f: -abs(f["contribution"]) if f["contribution"] is not None else 1.0)
    factors = list(physical)
    if c.get("ai_p_high") is not None:
        p = float(c["ai_p_high"])
        factors.append({"key": "ai", "text": f"AI: {_pct(p)} chance this ends high-risk", "probability": p, "bar": round(p, 4),
                        "effect": "raises" if c.get("ai_threshold") is not None and p >= c["ai_threshold"] else "neutral",
                        "in_domain": bool(c.get("ai_in_domain", True))})
    return {
        "factors": factors,
        "method": "AI contribution = AI probability now − AI probability with that input set to its training median (a typical ESA event). shap.TreeExplainer does not support the calibrated model.",
    }


def annotate(results: list[dict], now: datetime, period_s: dict[int, float] | None = None) -> None:
    """Add `decision` and `explanation` to each /screen result (in place) and sort: GO, MONITOR, WATCH, NO-GO, then Pc."""
    for c in results:
        mover = c["primary_norad"] if c.get("primary_object_type") == "PAYLOAD" else c["norad"] if c.get("object_type") == "PAYLOAD" else c["primary_norad"]
        c["decision"] = evaluate(c, None, now, (period_s or {}).get(mover))
        c["explanation"] = explain(c)
    results.sort(key=lambda c: (c["decision"]["rank"], -c["pc"], c["miss_km"]))


def period_from_tle(tle2: str) -> float | None:
    """Orbital period (s) from TLE line 2 mean motion (rev/day)."""
    try:
        n = float(tle2[52:63])
    except ValueError:
        return None
    return 86400.0 / n if n > 0 and math.isfinite(n) else None


def assess(index, primary_entry: dict, secondary_entry: dict, tca: datetime, *, mass_kg: float | None = None,
           isp_s: float | None = None, target_pc: float = maneuver_opt.DEFAULT_TARGET_PC, hbr_m: float = 20.0,
           now: datetime | None = None, tank_kg: float | None = None, sk_ms_per_year: float | None = None) -> dict:
    """Avoidance plan + fuel + final decision for one conjunction (shared by /avoid and Sentinel).

    Returns the maneuver_opt plan (with Tsiolkovsky fuel) plus `decision`, `explanation` and `conjunction` (the
    re-refined /screen record with AI scores). Raises ValueError / RuntimeError from the planner.
    """
    core = maneuver_opt.plan(index, primary_entry, secondary_entry, tca, target_pc=target_pc, hbr_m=hbr_m)
    out = maneuver_opt.with_fuel(core, mass_kg, isp_s, tank_kg, sk_ms_per_year)
    # Final Go / No-Go now that the planner says whether a valid option exists. Recommendation only.
    try:
        rec = risk.describe_pair(primary_entry, secondary_entry, tca, hbr_m)
        if rec is not None:
            now = now or datetime.now(timezone.utc)
            ml.score_conjunctions([rec], now)
            mover = (out.get("maneuvering") or {}).get("norad")
            period = period_from_tle((primary_entry if mover in (None, primary_entry["norad"]) else secondary_entry)["tle2"])
            out["decision"] = evaluate(rec, out, now, period)
            out["explanation"] = explain(rec)
            out["conjunction"] = rec
    except Exception:  # never let the recommendation break the plan
        logging.getLogger("kesslerwatch").exception("decision for an avoidance plan failed")
    return out
