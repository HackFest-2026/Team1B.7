"""Sentinel watchlist: the important objects Sentinel screens against the full catalog on every refresh.

Defaults (each verified against the live catalog at resolve time, never assumed to exist):
  Crewed    ISS (NORAD 25544, "ISS (ZARYA)") and the Tiangong core module (48274, "CSS (TIANHE...)").
  Critical  Hubble Space Telescope (20580, "HST").
  Standard  Indian active payloads in LEO: Space-Track SATCAT COUNTRY = IND, OBJECT_TYPE = PAYLOAD, not decayed,
            present in our catalog with apogee < 2000 km, and listed in CelesTrak's "active" group (Space-Track has
            no operational-status field). Re-synced from SATCAT at most once a day.
User-added objects (search + "Add to Sentinel") default to Standard. Every tier can be edited; removing a default
hides it (it is not re-added by the next sync).

Stored in backend/sentinel.db, table `watchlist` (stdlib sqlite3; no extra dependency).
"""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import orbit

log = logging.getLogger("kesslerwatch.watchlist")

DB_PATH = Path(__file__).parent / "sentinel.db"
TIERS = ("Crewed", "Critical", "Standard")
TIER_RANK = {t: i for i, t in enumerate(TIERS)}
LEO_MAX_APOGEE_KM = 2000.0
COUNTRY = "IND"
SYNC_TTL_S = 24 * 3600

# NORAD ID + the name the catalog must show for it (checked; a mismatch is reported, not silently used).
NAMED_DEFAULTS = [
    {"norad": 25544, "expect": "ISS", "tier": "Crewed", "note": "International Space Station"},
    {"norad": 48274, "expect": "TIANHE", "tier": "Crewed", "note": "Tiangong space station, Tianhe core module"},
    {"norad": 20580, "expect": "HST", "tier": "Critical", "note": "Hubble Space Telescope"},
]

_lock = threading.Lock()
_last_sync = 0.0
_sync_info: dict = {}


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(
        """CREATE TABLE IF NOT EXISTS watchlist (
            norad INTEGER PRIMARY KEY, name TEXT, tier TEXT NOT NULL, source TEXT NOT NULL,
            note TEXT, enabled INTEGER NOT NULL DEFAULT 1, added_utc TEXT NOT NULL)"""
    )
    return c


@contextmanager
def _db():
    """Connection that commits on success and is always closed."""
    c = _conn()
    try:
        with c:
            yield c
    finally:
        c.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sync_defaults(by_norad: dict[int, dict], force: bool = False) -> dict:
    """Insert default objects that are verified in the catalog and not yet in the table. Returns sync info."""
    global _last_sync, _sync_info
    with _lock:
        if not force and _sync_info and time.time() - _last_sync < SYNC_TTL_S:
            return _sync_info
        info: dict = {"synced_utc": _now(), "named": [], "country": COUNTRY}
        rows: list[tuple] = []
        for d in NAMED_DEFAULTS:
            e = by_norad.get(d["norad"])
            ok = bool(e and d["expect"] in e["name"].upper())
            info["named"].append({"norad": d["norad"], "found": ok, "catalog_name": e["name"] if e else None})
            if ok:
                rows.append((d["norad"], e["name"], d["tier"], "default", d["note"]))
            else:
                log.warning("watchlist default %s not verified in catalog (found %r)", d["norad"], e and e["name"])

        sat = orbit.spacetrack_satcat_payloads(COUNTRY)
        active = orbit.celestrak_active_norads()
        if sat is None:
            info["country_note"] = "Space-Track SATCAT unavailable (no credentials or upstream failure); Indian payloads not added."
        else:
            sat_rows, fetched = sat
            info["satcat_fetched_utc"] = fetched
            info["satcat_payloads_on_orbit"] = len(sat_rows)
            leo = []
            for r in sat_rows:
                try:
                    n = int(r["NORAD_CAT_ID"])
                except (KeyError, ValueError):
                    continue
                e = by_norad.get(n)
                if e and e["object_type"] == "PAYLOAD" and e["apogee_km"] < LEO_MAX_APOGEE_KM:
                    leo.append((n, e))
            info["in_catalog_leo"] = len(leo)
            if active is None:
                info["country_note"] = "CelesTrak active list unavailable; all Indian LEO payloads in the catalog added (activity not verified)."
                picked = leo
            else:
                picked = [(n, e) for n, e in leo if n in active]
                info["active_per_celestrak"] = len(picked)
            rows += [(n, e["name"], "Standard", "default:IND", "Indian payload in LEO (SATCAT COUNTRY=IND; active per CelesTrak)") for n, e in picked]

        with _db() as c:
            for norad, name, tier, source, note in rows:
                c.execute(
                    "INSERT OR IGNORE INTO watchlist (norad, name, tier, source, note, enabled, added_utc) VALUES (?,?,?,?,?,1,?)",
                    (norad, name, tier, source, note, _now()),
                )
        _last_sync, _sync_info = time.time(), info
        return info


def items(include_disabled: bool = False) -> list[dict]:
    with _db() as c:
        q = "SELECT * FROM watchlist" + ("" if include_disabled else " WHERE enabled = 1")
        rows = [dict(r) for r in c.execute(q)]
    rows.sort(key=lambda r: (TIER_RANK.get(r["tier"], 9), r["name"] or ""))
    return rows


def resolve(by_norad: dict[int, dict]) -> tuple[list[dict], list[dict]]:
    """(watched items with their catalog entry, items missing from the catalog)."""
    found, missing = [], []
    for it in items():
        e = by_norad.get(it["norad"])
        (found if e else missing).append({**it, "entry": e} if e else it)
    return found, missing


def add(norad: int, name: str, tier: str = "Standard") -> dict:
    if tier not in TIERS:
        raise ValueError(f"tier must be one of {', '.join(TIERS)}")
    with _db() as c:
        c.execute(
            """INSERT INTO watchlist (norad, name, tier, source, note, enabled, added_utc) VALUES (?,?,?,?,?,1,?)
               ON CONFLICT(norad) DO UPDATE SET enabled = 1, tier = excluded.tier""",
            (norad, name, tier, "user", "Added by user", _now()),
        )
        return dict(c.execute("SELECT * FROM watchlist WHERE norad = ?", (norad,)).fetchone())


def set_tier(norad: int, tier: str) -> dict | None:
    if tier not in TIERS:
        raise ValueError(f"tier must be one of {', '.join(TIERS)}")
    with _db() as c:
        c.execute("UPDATE watchlist SET tier = ? WHERE norad = ?", (tier, norad))
        r = c.execute("SELECT * FROM watchlist WHERE norad = ?", (norad,)).fetchone()
        return dict(r) if r else None


def remove(norad: int) -> bool:
    """User rows are deleted; default rows are disabled so the daily sync does not bring them back."""
    with _db() as c:
        r = c.execute("SELECT source FROM watchlist WHERE norad = ?", (norad,)).fetchone()
        if not r:
            return False
        if r["source"] == "user":
            c.execute("DELETE FROM watchlist WHERE norad = ?", (norad,))
        else:
            c.execute("UPDATE watchlist SET enabled = 0 WHERE norad = ?", (norad,))
        return True


def sync_info() -> dict:
    return _sync_info
