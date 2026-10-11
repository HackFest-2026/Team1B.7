"""Sentinel: a continuously running conjunction monitor for the watchlist (see watchlist.py).

Every cycle (REFRESH_S, started from the FastAPI lifespan in main.py):
  1. Rebuild the catalog (orbit.build_catalog: Space-Track GP at most once per hour via its cache, CelesTrak fallback).
  2. Screen every watched object against the full catalog for the next 72 h in ONE shared pass (risk.screen_many).
  3. Score with the live AI model (ml.score_conjunctions) and the Go / No-Go engine (decision.annotate).
  4. Track alerts that are WATCH or above, or carry the AI early flag. WATCH / GO alerts that can manoeuvre get the
     avoidance plan + fuel (decision.assess → maneuver_opt), re-planned only when either element set changed
     (or the stored plan predates the fuel block).
  5. Apply the false-alert guard (`guard_step`), persist to SQLite (backend/sentinel.db) with a history point per
     data update, and notify (SSE /sentinel/stream, optional Telegram) on new WATCH and CONFIRMED GO.

Status ladder (guard_step):
  NEW           AI early flag only; physics does not confirm it (decision NO-GO). Tracked, not escalated.
  WATCH         Decision WATCH / MONITOR, or GO still awaiting confirmation, or GO capped by stale data.
  CONFIRMED GO  Decision GO AND (GO threshold met on 2 consecutive data updates OR Pc and AI final risk both ≥ GO
                level). Never with a TLE older than 3 days ("stale data" caps it at WATCH).
  RESOLVED      New data lowered the risk below every threshold, the approach left the 10 km screen, or TCA passed.
A "data update" for an alert is a run in which either object's element set (TLE epoch) changed.
TCAs more than 48 h out are marked "lower confidence" (TLE errors grow with time).

Replay (`Replay`): plays a real high-risk ESA Kelvins test event, one CDM every few seconds, through the same AI,
decision and guard code. Clearly labelled as historical; avoidance / fuel are n/a in replay.
Recommendation only: nothing here executes a manoeuvre.
"""
from __future__ import annotations

import asyncio
import collections
import csv
import json
import logging
import math
import random
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

import httpx

import decision
import ml
import orbit
import risk
import watchlist

log = logging.getLogger("kesslerwatch.sentinel")

DB_PATH = watchlist.DB_PATH
REFRESH_S = 3600  # one cycle per hour: Space-Track GP may be queried at most once per hour
FIRST_RUN_DELAY_S = 3
HORIZON_H = 72.0
SCREEN_KM = 10.0
HBR_M = 20.0
LOWER_CONFIDENCE_H = 48.0
MAX_PLANS_PER_RUN = 6  # avoidance plans take ~10-60 s each; highest tier / Pc first, the rest next cycle
MATCH_WINDOW_S = 600  # same pair, TCA within ±10 min = the same alert across updates
STATUS_ORDER = {"CONFIRMED GO": 0, "WATCH": 1, "NEW": 2, "RESOLVED": 3}
NOTIFY_STATUSES = ("WATCH", "CONFIRMED GO")
NOTIFY_MAX_PER_RUN = 5  # individual notifications per cycle (most severe first); the rest go out as one summary
TELEGRAM_URL = "https://api.telegram.org/bot{token}/sendMessage"


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _sci(x: float | None) -> str:
    if x is None:
        return "n/a"
    return "< 1e−12" if x < 1e-12 else f"{x:.1e}".replace("e-0", "e−").replace("e-", "e−")


# =========================================================================== false-alert guard (pure)


def guard_step(prev: dict | None, *, decision_code: str, pc: float, ai_risk: float | None, stale: bool,
               early_flag: bool, data_update: bool, cfg: dict | None = None) -> dict:
    """Next status of one alert. `prev` = {"consec_go": int} from the previous update (None for a new alert)."""
    cfg = cfg or decision.config()
    n_req = int(cfg["confirm_updates"])
    go_level = pc >= cfg["go_pc"] or (ai_risk is not None and ai_risk >= cfg["go_ai_final_risk"])
    consec = int(prev.get("consec_go", 0)) if prev else 0
    if prev is None or data_update:
        consec = consec + 1 if go_level else 0
    dual = pc >= cfg["go_pc"] and ai_risk is not None and ai_risk >= cfg["confirm_ai_final_risk"]
    capped = False
    if decision_code == "GO" and (consec >= n_req or dual):
        if stale:
            status, capped = "WATCH", True
            reason = "GO, but a TLE is older than 3 days: capped at WATCH (stale data). Wait for fresh orbit data."
        else:
            status = "CONFIRMED GO"
            reason = (f"GO threshold met on {consec} consecutive data updates" if consec >= n_req
                      else f"Pc {_sci(pc)} and AI final risk {_sci(ai_risk)} both at GO level, independently")
    elif decision_code == "GO":
        status = "WATCH"
        reason = f"GO, awaiting confirmation: {consec} of {n_req} consecutive data updates above the GO threshold"
    elif decision_code in ("WATCH", "MONITOR"):
        status = "WATCH"
        reason = "Physics-confirmed WATCH" if decision_code == "WATCH" else "High risk, but neither object can manoeuvre"
    elif early_flag:
        status = "NEW"
        reason = "AI early flag only; physics does not confirm it (Pc below WATCH thresholds)"
    else:
        status = "RESOLVED"
        reason = "New data lowered the risk below every threshold"
    return {"status": status, "reason": reason, "consec_go": consec, "capped_stale": capped}


# =========================================================================== storage


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, primary_norad INTEGER, primary_name TEXT, tier TEXT,
        secondary_norad INTEGER, secondary_name TEXT, secondary_type TEXT,
        tca_utc TEXT, miss_km REAL, pc REAL, ai_p_high REAL, ai_log10_risk REAL,
        decision TEXT, status TEXT, status_reason TEXT, stale INTEGER, early_flag INTEGER, lower_confidence INTEGER,
        dv_ms REAL, propellant_kg REAL, burn_utc TEXT, consec_go INTEGER, updates INTEGER,
        primary_epoch TEXT, secondary_epoch TEXT, first_seen TEXT, last_updated TEXT, resolved_utc TEXT,
        notified TEXT, record TEXT, decision_json TEXT, explanation TEXT, plan TEXT)""",
    """CREATE TABLE IF NOT EXISTS history (
        alert_id TEXT, t_utc TEXT, pc REAL, ai_p_high REAL, ai_log10_risk REAL, miss_km REAL,
        decision TEXT, status TEXT, data_update INTEGER)""",
    "CREATE INDEX IF NOT EXISTS history_alert ON history(alert_id)",
    """CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_utc TEXT, finished_utc TEXT, trigger TEXT,
        catalog_source TEXT, catalog_fetched_utc TEXT, objects_watched INTEGER, pairs_checked INTEGER,
        conjunctions INTEGER, tracked INTEGER, plans INTEGER, seconds REAL, screen_seconds REAL, error TEXT, stats TEXT)""",
]


@contextmanager
def _db():
    c = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    c.row_factory = sqlite3.Row
    try:
        with c:
            c.execute("PRAGMA journal_mode=WAL")
            for q in SCHEMA:
                c.execute(q)
            yield c
    finally:
        c.close()


ALERT_COLS = ["id", "primary_norad", "primary_name", "tier", "secondary_norad", "secondary_name", "secondary_type",
              "tca_utc", "miss_km", "pc", "ai_p_high", "ai_log10_risk", "decision", "status", "status_reason", "stale",
              "early_flag", "lower_confidence", "dv_ms", "propellant_kg", "burn_utc", "consec_go", "updates",
              "primary_epoch", "secondary_epoch", "first_seen", "last_updated", "resolved_utc", "notified", "record",
              "decision_json", "explanation", "plan"]
JSON_COLS = ("notified", "record", "decision_json", "explanation", "plan")


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    for k in JSON_COLS:
        d[k] = json.loads(d[k]) if d.get(k) else None
    for k in ("stale", "early_flag", "lower_confidence"):
        d[k] = bool(d[k])
    return d


def _save(c: sqlite3.Connection, a: dict) -> None:
    vals = [json.dumps(a[k]) if k in JSON_COLS and a.get(k) is not None else a.get(k) for k in ALERT_COLS]
    c.execute(f"INSERT OR REPLACE INTO alerts ({','.join(ALERT_COLS)}) VALUES ({','.join('?' * len(ALERT_COLS))})", vals)


def _compact_plan(p: dict | None) -> dict | None:
    """What the board needs from an /avoid plan (the ~600 grid candidates are dropped)."""
    if not p:
        return None
    keep = ("possible", "reason", "note", "primary", "secondary", "maneuvering", "other", "tca_utc", "baseline", "target_pc", "recommended",
            "decision_deadline", "path", "inputs", "assumptions", "timing_s", "fuel", "lead_curve")
    out = {k: p.get(k) for k in keep if k in p}
    if p.get("constraint"):
        out["constraint"] = {k: p["constraint"].get(k) for k in ("checked", "passed", "window_start_utc", "window_end_utc")}
    return out


def cost_of_acting(plan: dict | None, early_flag_only: bool = False) -> dict:
    """Δv, propellant and burn time of the recommended option, or why there is none."""
    if early_flag_only:
        return {"available": False, "reason": "Not planned: AI early flag only (not physics-confirmed)."}
    if plan is None:
        return {"available": False, "reason": f"Avoidance plan pending: Sentinel plans up to {MAX_PLANS_PER_RUN} alerts per hourly cycle, highest tier and risk first."}
    if plan.get("error"):
        return {"available": False, "reason": f"Planner failed: {plan['error']}"}
    if not plan.get("possible"):
        return {"available": False, "reason": plan.get("reason") or "No manoeuvre possible."}
    r = plan.get("recommended")
    if not r:
        return {"available": False, "reason": plan.get("note") or "No valid option in the grid."}
    f = (plan.get("fuel") or {}).get("recommended") or {}
    return {"available": True, "dv_ms": r["dv_ms"], "direction": r["direction"], "direction_label": r.get("direction_label"),
            "propellant_kg": r.get("propellant_kg"), "burn_utc": r["burn_utc"], "lead_h": r.get("lead_h"),
            # avoid + return-to-orbit (est., equal Δv); absent on plans stored before the fuel block existed
            "total_dv_ms": f.get("total_dv_ms"), "return_kg": f.get("return_kg"), "total_kg": f.get("total_kg"),
            "tank_pct": f.get("tank_pct"), "life_days": f.get("life_days"),
            "new_pc": r.get("new_pc"), "new_miss_km": r.get("new_miss_km"),
            "mass_assumed": (plan.get("inputs") or {}).get("mass_assumed", True),
            "maneuvering": (plan.get("maneuvering") or {}).get("name")}


def _public(a: dict, history: list[dict] | None = None, detail: bool = False) -> dict:
    """API shape of one alert."""
    now = datetime.now(timezone.utc)
    hours = (_parse(a["tca_utc"]) - now).total_seconds() / 3600.0
    ai_risk = 10.0 ** a["ai_log10_risk"] if a.get("ai_log10_risk") is not None else None
    early_only = a["status"] == "NEW" or (a.get("early_flag") and a.get("decision") == "NO-GO")
    out = {k: a.get(k) for k in ("id", "primary_norad", "primary_name", "tier", "secondary_norad", "secondary_name",
                                  "secondary_type", "tca_utc", "miss_km", "pc", "ai_p_high", "ai_log10_risk", "decision",
                                  "status", "status_reason", "stale", "early_flag", "consec_go", "updates", "first_seen",
                                  "last_updated", "resolved_utc", "dv_ms", "propellant_kg", "burn_utc")}
    out["hours_to_tca"] = round(hours, 2)
    out["lower_confidence"] = hours > LOWER_CONFIDENCE_H
    out["cost_of_acting"] = cost_of_acting(a.get("plan"), early_only)
    out["risk_of_not_acting"] = {"pc": a.get("pc"), "ai_final_risk": ai_risk, "ai_p_high": a.get("ai_p_high"),
                                 "ai_in_domain": (a.get("record") or {}).get("ai_in_domain")}
    if detail:
        out["record"] = a.get("record")
        out["decision_detail"] = a.get("decision_json")
        out["explanation"] = a.get("explanation")
        out["plan"] = a.get("plan")
        out["history"] = history or []
    return out


# =========================================================================== notifications


class Notifier:
    """Fan-out to SSE subscribers (asyncio queues, fed thread-safely). Every event gets an increasing id and the
    last EVENT_BUFFER events are kept, so a client reconnecting with Last-Event-ID misses nothing."""

    EVENT_BUFFER = 300

    def __init__(self) -> None:
        self.subs: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self.lock = threading.Lock()
        self.seq = 0
        self.recent: collections.deque[tuple[int, dict]] = collections.deque(maxlen=self.EVENT_BUFFER)

    def since(self, last_id: int) -> list[tuple[int, dict]]:
        with self.lock:
            return [(i, m) for i, m in self.recent if i > last_id]

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        with self.lock:
            self.subs.append((asyncio.get_running_loop(), q))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self.lock:
            self.subs = [(lp, x) for lp, x in self.subs if x is not q]

    def publish(self, msg: dict) -> None:
        def put(q: asyncio.Queue) -> None:
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass

        with self.lock:
            self.seq += 1
            msg = {**msg, "_id": self.seq}
            self.recent.append((self.seq, msg))
            subs = list(self.subs)
        for lp, q in subs:
            try:
                lp.call_soon_threadsafe(put, q)
            except RuntimeError:  # loop closed
                self.unsubscribe(q)


def telegram_configured() -> bool:
    return bool(orbit._env("TELEGRAM_BOT_TOKEN") and orbit._env("TELEGRAM_CHAT_ID"))


def send_telegram(text: str) -> bool:
    """Short message via the Telegram Bot API if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set; else nothing.
    The token is part of the URL, so neither the URL nor the exception text is ever logged."""
    token, chat = orbit._env("TELEGRAM_BOT_TOKEN"), orbit._env("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return False
    try:
        r = httpx.post(TELEGRAM_URL.format(token=token), data={"chat_id": chat, "text": text}, timeout=10)
        if r.status_code != 200:
            log.warning("Telegram send failed: HTTP %s", r.status_code)
            return False
        return True
    except httpx.HTTPError as e:
        log.warning("Telegram send failed: %s", type(e).__name__)
        return False


def alert_text(a: dict) -> str:
    cost = a["cost_of_acting"]
    dv = f"Δv {cost['dv_ms']:.3g} m/s (est.)" if cost.get("available") else "Δv n/a"
    return (f"KesslerWatch Sentinel: {a['status']}\n"
            f"{a['primary_name']} vs {a['secondary_name']} ({a.get('secondary_type') or 'UNKNOWN'})\n"
            f"TCA {a['tca_utc'][:16].replace('T', ' ')} UTC (T−{max(a['hours_to_tca'], 0):.1f} h)\n"
            f"Miss {a['miss_km']:.2f} km · Pc {_sci(a['pc'])}\n"
            f"Decision {a['decision']} · {dv}\n"
            "Recommendation — operator decides.")


# =========================================================================== monitor


@dataclass
class Hooks:
    """Provided by main.py so Sentinel shares the API's catalog and screening index."""

    refresh_catalog: Callable[[], tuple[list[dict], dict, dict[int, dict]]]
    get_index: Callable[[], risk.CatalogIndex]


class Sentinel:
    def __init__(self) -> None:
        self.notifier = Notifier()
        self.hooks: Hooks | None = None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.run_lock = threading.Lock()
        self.busy = False
        self.phase: str | None = None
        self.last_started: float | None = None
        self.next_run: float | None = None
        self.last_error: str | None = None

    # ---- lifecycle
    def start(self, hooks: Hooks) -> None:
        self.hooks = hooks
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        # Keep the hourly cadence across restarts (e.g. uvicorn --reload): resume from the last recorded cycle.
        self.next_run = time.time() + FIRST_RUN_DELAY_S
        try:
            with _db() as c:
                r = c.execute("SELECT started_utc FROM runs WHERE error IS NULL ORDER BY id DESC LIMIT 1").fetchone()
            if r:
                self.next_run = max(self.next_run, _parse(r["started_utc"]).timestamp() + REFRESH_S)
        except Exception:
            log.exception("could not read the last Sentinel run")
        self.thread = threading.Thread(target=self._loop, name="sentinel", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake.set()

    def trigger(self) -> bool:
        """Run now (if idle). The catalog still comes from cache unless it is over an hour old."""
        if self.busy:
            return False
        self.next_run = time.time()
        self.wake.set()
        return True

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            delay = max(0.0, (self.next_run or 0) - time.time())
            self.wake.wait(timeout=delay)
            self.wake.clear()
            if self.stop_event.is_set():
                break
            if time.time() + 0.5 < (self.next_run or 0):
                continue
            self.last_started = time.time()
            self.next_run = self.last_started + REFRESH_S
            try:
                self.run_once("scheduled")
            except Exception:
                log.exception("Sentinel cycle failed")

    # ---- one cycle
    def run_once(self, trigger: str = "manual") -> dict | None:
        if not self.run_lock.acquire(blocking=False):
            return None
        self.busy = True
        started = datetime.now(timezone.utc)
        t_start = time.perf_counter()
        summary: dict = {"started_utc": _iso(started), "trigger": trigger}
        self.notifier.publish({"type": "run", "phase": "started", "started_utc": summary["started_utc"]})
        try:
            self.phase = "catalog"
            entries, meta, by = self.hooks.refresh_catalog()
            watchlist.sync_defaults(by)
            watched, missing = watchlist.resolve(by)
            index = self.hooks.get_index()
            summary.update(catalog_source=meta.get("source"), catalog_fetched_utc=meta.get("fetched_utc"),
                           objects_watched=len(watched), missing=[m["norad"] for m in missing])

            self.phase = "screening"
            t0 = started.replace(microsecond=0)
            res, per, run = risk.screen_many(index, [w["entry"] for w in watched], HORIZON_H, SCREEN_KM, HBR_M, t0)
            summary.update(pairs_checked=run["pairs_checked"], screen_seconds=run["seconds"], screen=run)

            # One record per physical event: if both objects are watched, keep the higher-tier side as primary.
            recs: dict[tuple, dict] = {}
            for w, lst in zip(watched, res):
                for c in lst:
                    c["primary_name"], c["tier"] = w["name"], w["tier"]
                    key = (frozenset((c["primary_norad"], c["norad"])), round(_parse(c["tca_utc"]).timestamp() / 300))
                    if key not in recs or watchlist.TIER_RANK[w["tier"]] < watchlist.TIER_RANK[recs[key]["tier"]]:
                        recs[key] = c
            records = list(recs.values())
            summary["conjunctions"] = len(records)

            self.phase = "scoring"
            try:
                ml.score_conjunctions(records, t0)
            except Exception:
                log.exception("AI scoring failed in Sentinel")
            periods = {}
            for c in records:
                for n in (c["primary_norad"], c["norad"]):
                    if n not in periods and n in by:
                        periods[n] = decision.period_from_tle(by[n]["tle2"])
            decision.annotate(records, started, periods)
            tracked = [c for c in records if c["decision"]["decision"] != "NO-GO" or c["decision"]["early_flag"]]
            tracked.sort(key=lambda c: (watchlist.TIER_RANK[c["tier"]], c["decision"]["rank"], -c["pc"]))
            summary["tracked"] = len(tracked)
            summary["decisions"] = {d: sum(1 for c in records if c["decision"]["decision"] == d) for d in decision.RANK}
            summary["early_flagged"] = sum(1 for c in records if c["decision"]["early_flag"])

            self.phase = "alerts"
            plans_done = self._update_alerts(tracked, by, index, started)
            summary["plans"] = plans_done
        except Exception as e:
            log.exception("Sentinel run failed")
            summary["error"] = f"{type(e).__name__}: {e}"[:300]
        finally:
            summary["finished_utc"] = _iso(datetime.now(timezone.utc))
            summary["seconds"] = round(time.perf_counter() - t_start, 1)
            self.last_error = summary.get("error")
            self._record_run(summary)
            self.busy = False
            self.phase = None
            self.run_lock.release()
            self.notifier.publish({"type": "run", "phase": "finished", "status": self.status()})
            log.info("Sentinel %s: %s watched, %s conjunctions, %s tracked, %s plans, %.0f s%s", trigger,
                     summary.get("objects_watched"), summary.get("conjunctions"), summary.get("tracked"),
                     summary.get("plans"), summary["seconds"], f" ERROR {summary['error']}" if summary.get("error") else "")
        return summary

    def _update_alerts(self, tracked: list[dict], by: dict[int, dict], index, now: datetime) -> int:
        cfg = decision.config()
        with _db() as c:
            open_rows = [_row(r) for r in c.execute("SELECT * FROM alerts WHERE tca_utc >= ?", (_iso(now - timedelta(hours=1)),))]
        by_pair: dict[tuple[int, int], list[dict]] = {}
        for a in open_rows:
            by_pair.setdefault((a["primary_norad"], a["secondary_norad"]), []).append(a)

        seen: set[str] = set()
        plans_done = 0
        notifications: list[dict] = []
        for rec in tracked:
            pe, se = by.get(rec["primary_norad"]), by.get(rec["norad"])
            if not pe or not se:
                continue
            tca = _parse(rec["tca_utc"])
            prev = None
            for cand in by_pair.get((rec["primary_norad"], rec["norad"]), []) + by_pair.get((rec["norad"], rec["primary_norad"]), []):
                if abs((_parse(cand["tca_utc"]) - tca).total_seconds()) <= MATCH_WINDOW_S and cand["id"] not in seen:
                    prev = cand
                    break
            data_update = prev is None or prev.get("primary_epoch") != pe["epoch"] or prev.get("secondary_epoch") != se["epoch"]
            plan = None if data_update or prev is None else prev.get("plan")
            if plan and plan.get("recommended") and "fuel" not in plan:
                plan = None  # stored before the fuel block (return burn, tank, lead-time curve) existed: re-plan once
            final = rec["decision"]
            explanation = rec.get("explanation")
            wants_plan = final["decision"] in ("GO", "WATCH") and decision.can_manoeuvre(rec)
            planned_now = False
            if wants_plan and plan is None and plans_done < MAX_PLANS_PER_RUN:
                planned_now = True
                self.phase = f"planning {plans_done + 1}"
                try:
                    out = decision.assess(index, pe, se, tca, now=now)
                    plan = _compact_plan(out)
                    if out.get("decision"):
                        final, explanation = out["decision"], out.get("explanation") or explanation
                except (ValueError, RuntimeError) as e:
                    plan = {"possible": False, "error": str(e)[:200]}
                plans_done += 1
            elif plan and plan.get("possible") and not plan.get("error"):
                period = decision.period_from_tle(((plan.get("maneuvering") or {}).get("norad") == se["norad"] and se or pe)["tle2"])
                final = decision.evaluate(rec, plan, now, period)

            ai_risk = 10.0 ** rec["ai_log10_risk"] if rec.get("ai_log10_risk") is not None else None
            g = guard_step(prev, decision_code=final["decision"], pc=rec["pc"], ai_risk=ai_risk, stale=final.get("stale", False),
                           early_flag=final.get("early_flag", False), data_update=data_update, cfg=cfg)
            if prev and not data_update and not planned_now and prev["status"] == g["status"] and prev.get("decision") == final["decision"]:
                # Same element sets, same outcome: refresh timestamps only (no new history point).
                prev["last_updated"] = _iso(now)
                seen.add(prev["id"])
                with _db() as c:
                    _save(c, prev)
                continue
            rec_plan = (plan or {}).get("recommended") or {}
            a = {
                "id": prev["id"] if prev else f"{rec['primary_norad']}-{rec['norad']}-{tca.strftime('%Y%m%dT%H%M')}",
                "primary_norad": rec["primary_norad"], "primary_name": rec["primary_name"], "tier": rec["tier"],
                "secondary_norad": rec["norad"], "secondary_name": rec["name"], "secondary_type": rec["object_type"],
                "tca_utc": rec["tca_utc"], "miss_km": rec["miss_km"], "pc": rec["pc"], "ai_p_high": rec.get("ai_p_high"),
                "ai_log10_risk": rec.get("ai_log10_risk"), "decision": final["decision"], "status": g["status"],
                "status_reason": g["reason"], "stale": final.get("stale", False), "early_flag": final.get("early_flag", False),
                "lower_confidence": (tca - now).total_seconds() / 3600.0 > LOWER_CONFIDENCE_H,
                "dv_ms": rec_plan.get("dv_ms"), "propellant_kg": rec_plan.get("propellant_kg"), "burn_utc": rec_plan.get("burn_utc"),
                "consec_go": g["consec_go"], "updates": (prev["updates"] if prev else 0) + (1 if data_update else 0),
                "primary_epoch": pe["epoch"], "secondary_epoch": se["epoch"],
                "first_seen": prev["first_seen"] if prev else _iso(now), "last_updated": _iso(now),
                "resolved_utc": _iso(now) if g["status"] == "RESOLVED" else None,
                "notified": (prev.get("notified") if prev else None) or [],
                "record": {k: v for k, v in rec.items() if k not in ("decision", "explanation")},
                "decision_json": final, "explanation": explanation, "plan": plan,
            }
            seen.add(a["id"])
            if a["status"] in NOTIFY_STATUSES and a["status"] not in a["notified"]:
                a["notified"] = a["notified"] + [a["status"]]
                notifications.append(a)
            with _db() as c:
                _save(c, a)
                c.execute("INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?)",
                          (a["id"], _iso(now), a["pc"], a["ai_p_high"], a["ai_log10_risk"], a["miss_km"], a["decision"], a["status"], int(data_update)))

        # Open alerts not seen this cycle: resolved (left the screen, dropped below every threshold, or TCA passed).
        with _db() as c:
            for a in open_rows:
                if a["id"] in seen or a["status"] == "RESOLVED":
                    continue
                passed = _parse(a["tca_utc"]) < now
                a["status"] = "RESOLVED"
                a["status_reason"] = "TCA passed" if passed else "Latest data: below every threshold or outside the 10 km screen"
                a["resolved_utc"] = a["last_updated"] = _iso(now)
                _save(c, a)
                c.execute("INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?)",
                          (a["id"], _iso(now), a["pc"], a["ai_p_high"], a["ai_log10_risk"], a["miss_km"], a["decision"], "RESOLVED", 1))
        notifications.sort(key=lambda a: (STATUS_ORDER[a["status"]], watchlist.TIER_RANK.get(a["tier"], 9), -a["pc"]))
        for a in notifications[:NOTIFY_MAX_PER_RUN]:
            pub = _public(a)
            self.notifier.publish({"type": "alert", "dedupe": f"{a['id']}|{a['status']}", "alert": pub})
            send_telegram(alert_text(pub))
        rest = notifications[NOTIFY_MAX_PER_RUN:]
        if rest:
            by_status = {st: sum(1 for a in rest if a["status"] == st) for st in NOTIFY_STATUSES}
            text = " and ".join(f"{n} {st}" for st, n in by_status.items() if n)
            self.notifier.publish({"type": "alert_summary", "dedupe": f"summary|{_iso(now)}", "count": len(rest), "by_status": by_status,
                                   "text": f"{text} more alerts this cycle. See the Sentinel board."})
            send_telegram(f"KesslerWatch Sentinel: {text} more alerts this cycle (not listed individually). See the Sentinel board.")
        return plans_done

    def _record_run(self, s: dict) -> None:
        with _db() as c:
            c.execute(
                "INSERT INTO runs (started_utc, finished_utc, trigger, catalog_source, catalog_fetched_utc, objects_watched, pairs_checked,"
                " conjunctions, tracked, plans, seconds, screen_seconds, error, stats) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (s.get("started_utc"), s.get("finished_utc"), s.get("trigger"), s.get("catalog_source"), s.get("catalog_fetched_utc"),
                 s.get("objects_watched"), s.get("pairs_checked"), s.get("conjunctions"), s.get("tracked"), s.get("plans"),
                 s.get("seconds"), s.get("screen_seconds"), s.get("error"), json.dumps(s)),
            )

    # ---- read API
    def status(self) -> dict:
        with _db() as c:
            r = c.execute("SELECT * FROM runs WHERE finished_utc IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
            counts = {row["status"]: row["n"] for row in c.execute("SELECT status, COUNT(*) AS n FROM alerts WHERE tca_utc >= ? GROUP BY status",
                                                                    (_iso(datetime.now(timezone.utc)),))}
        last = None
        if r:
            last = {k: r[k] for k in ("started_utc", "finished_utc", "trigger", "catalog_source", "catalog_fetched_utc", "objects_watched",
                                      "pairs_checked", "conjunctions", "tracked", "plans", "seconds", "screen_seconds", "error")}
            stats = json.loads(r["stats"] or "{}")
            last["decisions"] = stats.get("decisions")
            last["early_flagged"] = stats.get("early_flagged")
            last["missing"] = stats.get("missing")
        return {
            "running": bool(self.thread and self.thread.is_alive()),
            "busy": self.busy,
            "phase": self.phase,
            "last_run": last,
            "next_refresh_utc": _iso(datetime.fromtimestamp(self.next_run, timezone.utc)) if self.next_run else None,
            "refresh_s": REFRESH_S,
            "horizon_h": HORIZON_H,
            "screen_km": SCREEN_KM,
            "lower_confidence_after_h": LOWER_CONFIDENCE_H,
            "alerts_by_status": counts,
            "objects_watched": len(watchlist.items()),
            "telegram_configured": telegram_configured(),
            "watchlist_sync": watchlist.sync_info(),
            "note": decision.OPERATOR_NOTE,
        }

    def alerts(self, include_resolved: bool = True) -> list[dict]:
        now = datetime.now(timezone.utc)
        with _db() as c:
            cols = ",".join(k for k in ALERT_COLS if k not in ("decision_json", "explanation"))  # board does not need these
            rows = [_row(r) for r in c.execute(f"SELECT {cols} FROM alerts WHERE tca_utc >= ?", (_iso(now - timedelta(hours=6)),))]
        out = [_public(a) for a in rows if include_resolved or a["status"] != "RESOLVED"]
        out.sort(key=lambda a: (STATUS_ORDER.get(a["status"], 9), -(a["pc"] or 0), watchlist.TIER_RANK.get(a["tier"], 9)))
        return out

    def alert(self, alert_id: str) -> dict | None:
        with _db() as c:
            r = c.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
            if not r:
                return None
            hist = [dict(h) for h in c.execute("SELECT t_utc, pc, ai_p_high, ai_log10_risk, miss_km, decision, status, data_update FROM history WHERE alert_id = ? ORDER BY t_utc", (alert_id,))]
        return _public(_row(r), hist, detail=True)


SENTINEL = Sentinel()


# =========================================================================== replay (historical ESA event)

KELVINS_TEST = ml.DATA_DIR / "test_data.csv"
KELVINS_LABELS = ml.DATA_DIR / "test_data_private.csv"
REPLAY_STEP_S = 4.0
REPLAY_MIN_CDMS = 6
REPLAY_BANNER = "REPLAY — ESA historical event (anonymised, 2015–2019). Not live."
_KELVINS_TYPES = {"DEBRIS": "DEBRIS", "PAYLOAD": "PAYLOAD", "ROCKET BODY": "ROCKET BODY", "UNKNOWN": "UNKNOWN", "TBA": "UNKNOWN"}
_SIGMAS = [f"{o}_sigma_{a}" for o in "tc" for a in "rtn"]
_CDM_COLS = ["event_id", "time_to_tca", "mission_id", "risk", "miss_distance", "relative_speed", "relative_position_r",
             "relative_position_t", "relative_position_n", "c_object_type", *_SIGMAS]


def _f(x: str) -> float | None:
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


class Replay:
    def __init__(self, notifier: Notifier) -> None:
        self.notifier = notifier
        self.events: dict[int, list[dict]] | None = None
        self.labels: dict[int, dict] = {}
        self.state: dict | None = None
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.lock = threading.Lock()

    def _load(self) -> None:
        if self.events is not None:
            return
        if not KELVINS_TEST.exists() or not KELVINS_LABELS.exists():
            raise FileNotFoundError("ESA Kelvins test set not found in backend/data/kelvins/ (see CLAUDE.md).")
        ev: dict[int, list[dict]] = {}
        with KELVINS_TEST.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                ev.setdefault(int(row["event_id"]), []).append({k: row.get(k) for k in _CDM_COLS})
        with KELVINS_LABELS.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                self.labels[int(row["event_id"])] = {"true_risk": _f(row["true_risk"]), "time_to_tca": _f(row["time_to_tca"]),
                                                     "miss_distance": _f(row["miss_distance"])}
        self.events = ev

    def _eligible(self) -> list[int]:
        return [e for e, rows in self.events.items()
                if len(rows) >= REPLAY_MIN_CDMS and (self.labels.get(e, {}).get("true_risk") or -99) >= ml.HIGH_RISK]

    @staticmethod
    def _record(row: dict, now: datetime) -> dict:
        tte = _f(row["time_to_tca"]) or 0.0
        sig = [(_f(row[k]) or 0.0) for k in _SIGMAS]
        sigma_km = math.sqrt(sum(x * x for x in sig) / 3.0) / 1000.0
        log_risk = max(_f(row["risk"]) or ml.RISK_FLOOR, ml.RISK_FLOOR)
        pc = 10.0 ** log_risk
        return {
            "norad": 0, "name": f"Chaser object (ESA event {row['event_id']}, anonymised)",
            "object_type": _KELVINS_TYPES.get((row.get("c_object_type") or "").upper(), "UNKNOWN"),
            "tca_utc": _iso(now + timedelta(days=tte)), "miss_km": round((_f(row["miss_distance"]) or 0.0) / 1000.0, 3),
            "radial_km": (_f(row["relative_position_r"]) or 0.0) / 1000.0, "in_track_km": (_f(row["relative_position_t"]) or 0.0) / 1000.0,
            "cross_track_km": (_f(row["relative_position_n"]) or 0.0) / 1000.0, "vrel_kms": (_f(row["relative_speed"]) or 0.0) / 1000.0,
            "sigma_km": round(sigma_km, 3), "pc": pc, "alert": pc >= risk.PC_ALERT,
            "level": "alert" if pc >= risk.PC_ALERT else "watch" if pc >= risk.PC_WATCH else "low",
            "primary_norad": 0, "primary_object_type": "PAYLOAD",  # the ESA satellite (Kelvins "target")
            "primary_tle_age_h": None, "secondary_tle_age_h": None, "time_to_tca_d": tte,
        }

    def start(self, event_id: int | None = None) -> dict:
        with self.lock:
            self._load()
            if self.thread and self.thread.is_alive():
                self.stop_event.set()
                self.thread.join(timeout=REPLAY_STEP_S + 2)
            pool = self._eligible()
            if not pool:
                raise ValueError("No high-risk event with enough CDMs in the test set.")
            eid = event_id if event_id in self.events else random.choice(pool)
            rows = sorted(self.events[eid], key=lambda r: -(_f(r["time_to_tca"]) or 0.0))
            self.state = {
                "active": True, "finished": False, "banner": REPLAY_BANNER, "event_id": eid,
                "mission_id": rows[0].get("mission_id"), "primary_name": f"ESA mission {rows[0].get('mission_id')} (anonymised)",
                "secondary_type": _KELVINS_TYPES.get((rows[0].get("c_object_type") or "").upper(), "UNKNOWN"),
                "total": len(rows), "step": 0, "step_s": REPLAY_STEP_S, "cdms": [], "current": None, "final": None,
                "avoidance": "n/a in replay", "fuel": "n/a in replay",
                "source": "ESA Kelvins Collision Avoidance Challenge, official test set (test_data.csv; final CDM from test_data_private.csv)",
            }
            self.stop_event.clear()
            self.thread = threading.Thread(target=self._play, args=(rows,), name="sentinel-replay", daemon=True)
            self.thread.start()
            return self.state

    def stop(self) -> dict | None:
        self.stop_event.set()
        if self.state:
            self.state["active"] = False
            self.notifier.publish({"type": "replay", "state": self.state})
        return self.state

    def _play(self, rows: list[dict]) -> None:
        cfg = decision.config()
        prev = None
        for i, row in enumerate(rows):
            if self.stop_event.is_set():
                return
            now = datetime.now(timezone.utc)
            rec = self._record(row, now)
            try:
                ml.score_conjunctions([rec], now)
            except Exception:
                log.exception("AI scoring failed in replay")
            d = decision.evaluate(rec, None, now, None)
            if d["decision"] == "GO":  # no orbit to plan for: the plan is n/a, so GO is taken at face value here
                d["headline"] = "GO thresholds met. Avoidance plan n/a in replay."
            ai_risk = 10.0 ** rec["ai_log10_risk"] if rec.get("ai_log10_risk") is not None else None
            g = guard_step(prev, decision_code=d["decision"], pc=rec["pc"], ai_risk=ai_risk, stale=False,
                           early_flag=d["early_flag"], data_update=True, cfg=cfg)
            prev = g
            point = {"step": i + 1, "time_to_tca_d": rec["time_to_tca_d"], "pc": rec["pc"], "ai_p_high": rec.get("ai_p_high"),
                     "ai_log10_risk": rec.get("ai_log10_risk"), "miss_km": rec["miss_km"], "decision": d["decision"],
                     "status": g["status"], "reason": g["reason"], "early_flag": d["early_flag"]}
            self.state["cdms"].append(point)
            self.state.update(step=i + 1, current={"record": rec, "decision": d, "explanation": decision.explain(rec), "guard": g})
            self.notifier.publish({"type": "replay", "state": self.state})
            if g["status"] in NOTIFY_STATUSES and (len(self.state["cdms"]) < 2 or self.state["cdms"][-2]["status"] != g["status"]):
                self.notifier.publish({"type": "alert", "replay": True, "dedupe": f"replay|{self.state['event_id']}|{g['status']}",
                                       "alert": {"status": g["status"], "primary_name": self.state["primary_name"],
                                                 "secondary_name": rec["name"], "pc": rec["pc"], "miss_km": rec["miss_km"],
                                                 "hours_to_tca": round(rec["time_to_tca_d"] * 24, 1), "decision": d["decision"]}})
            if self.stop_event.wait(REPLAY_STEP_S):
                return
        lab = self.labels.get(self.state["event_id"], {})
        fr = lab.get("true_risk")
        self.state["final"] = {"risk_log10": fr, "pc": 10.0 ** fr if fr is not None else None, "time_to_tca_d": lab.get("time_to_tca"),
                               "miss_km": (lab["miss_distance"] / 1000.0) if lab.get("miss_distance") is not None else None,
                               "high_risk": fr is not None and fr >= ml.HIGH_RISK,
                               "note": "ESA's final CDM for this event (the label the model was scored against), revealed after the replay."}
        self.state.update(finished=True, active=False)
        self.notifier.publish({"type": "replay", "state": self.state})


REPLAY = Replay(SENTINEL.notifier)
