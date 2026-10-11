"""AI risk model (build step 5): trained on ESA's Kelvins Collision Avoidance Challenge CDMs.

Run `python ml.py train` to (re)build backend/models/ from backend/data/kelvins/ (needs pandas, which
only training uses; the API server imports just numpy, scikit-learn and joblib).
Run `python ml.py throughput` to measure screening throughput on the live catalog (saved to metrics.json).
Run `python ml.py lstm` to benchmark an LSTM over the CDM sequences against the trees (needs torch; saved to
metrics.json model_comparison; the trees stay live unless the LSTM beats them on validation).
Run `python ml.py decision-kpis` to recompute the Go / No-Go decision-level KPIs on the ESA test sets without
retraining (saved to metrics.json kpis.decision_levels; `train` computes them too).

Task (Kelvins): each event_id is a time series of Conjunction Data Messages (CDMs). The target is the
`risk` (log10 collision probability) in the event's LAST CDM. Inputs may only use CDMs with
time_to_tca >= 2 days (an avoidance manoeuvre is planned at least 2 days before TCA).
High-risk = final risk >= -6 (Kelvins scoring: r >= 1e-6).

Split (by event, stratified, fixed seed): 60% train / 20% validation / 20% held-out test. The validation
events choose everything that is chosen (class weighting, the radial-separation input, the alert threshold);
the held-out test events and ESA's official test set are only used to report.

Models
  baseline : final risk = latest available risk ("latest risk prediction", LRP)
  full     : HistGradientBoosting; isotonic-calibrated classifier -> P(final risk >= -6), and a regressor
             for the CHANGE from the latest risk (so zero change = the baseline). Uses the latest CDM
             (all columns) plus simple trend features from the earlier CDMs.
  live     : same families but ONLY on quantities our live screener also produces (see LIVE_FEATURE_MAP).
"""
from __future__ import annotations

import json
import logging
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

log = logging.getLogger("kesslerwatch.ml")

BASE = Path(__file__).parent
DATA_DIR = BASE / "data" / "kelvins" / "kelvins_competition_data"
MODEL_DIR = BASE / "models"
METRICS_PATH = MODEL_DIR / "metrics.json"

SEED = 42
HIGH_RISK = -6.0  # log10; Kelvins: r >= 1e-6 is "high risk"
MIN_TCA_DAYS = 2.0  # inputs only from CDMs at least this far from TCA
MAX_TCA_DAYS = 7.0  # Kelvins CDMs are issued up to ~7 days before TCA
RISK_FLOOR = -30.0  # Kelvins clips risk at 1e-30
HOLDOUT_FRACTION = 0.2  # of all eligible events (unchanged from earlier runs, so the test events are the same)
VAL_FRACTION = 0.25  # of the remaining 80% -> 60 / 20 / 20
CAL_FOLDS = 5  # isotonic calibration: cross-fitted on this many folds of the training events
TARGET_RECALL = 0.95  # operating threshold: catch at least this share of high-risk VALIDATION events
LEAD_DAYS = (2.0, 3.0, 4.0, 5.0)  # lead-time KPI: inputs truncated to CDMs at least this many days before TCA
CAL_EDGES = [0.0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.7, 1.0000001]

# Kelvins `c_object_type` (the chaser / the other object) -> code; our catalog's OBJECT_TYPE maps the same way.
OBJECT_CODES = {"DEBRIS": 0, "PAYLOAD": 1, "ROCKET BODY": 2, "UNKNOWN": 3, "TBA": 3}

KELVINS_URL = "https://kelvins.esa.int/collision-avoidance-challenge/"
PAPER_URL = "https://arxiv.org/abs/2008.03069"
# Published results (Uriot et al., 2020, arXiv:2008.03069) on the official test set, for context only.
PUBLISHED = {
    "latest_risk_baseline": {"score": 0.694, "mse_hr": 0.513, "f2": 0.739},
    "winner_sesc": {"score": 0.556, "mse_hr": 0.407, "f2": 0.733},
    "source": PAPER_URL,
}

# Live model inputs. Two candidate sets: without and with the radial separation at TCA (chosen on validation).
LIVE_FEATURES_BASE = ["miss_distance_m", "relative_speed_ms", "time_to_tca_d", "log10_pc", "sigma_km", "miss_over_sigma", "object_type"]
LIVE_FEATURES_RADIAL = LIVE_FEATURES_BASE + ["radial_sep_m"]
LIVE_CATEGORICAL = ["object_type"]
LIVE_FEATURE_MAP = [
    {"feature": "miss_distance_m", "kelvins": "miss_distance [m]", "live": "miss_km × 1000"},
    {"feature": "relative_speed_ms", "kelvins": "relative_speed [m/s]", "live": "vrel_kms × 1000"},
    {"feature": "time_to_tca_d", "kelvins": "time_to_tca [days] of the latest CDM ≥ 2 d out", "live": "(TCA − now) in days; below 2 d the model is outside its training range"},
    {"feature": "log10_pc", "kelvins": "risk (ESA's log10 collision probability, full covariance)", "live": "log10(Pc) from our screener (isotropic assumed σ), floored at −30"},
    {"feature": "sigma_km", "kelvins": "√(((c_σr²+c_σt²+c_σn²)+(t_σr²+t_σt²+t_σn²))/3) / 1000", "live": "combined isotropic σ (km); identical formula when σ is isotropic"},
    {"feature": "miss_over_sigma", "kelvins": "miss_distance / (1000·sigma_km)", "live": "miss_km / sigma_km"},
    {"feature": "object_type", "kelvins": "c_object_type (TBA → UNKNOWN)", "live": "object_type of the other object (official Space-Track type)"},
    {"feature": "radial_sep_m", "kelvins": "|relative_position_r| [m] (ESA satellite's RTN frame)", "live": "|radial_km| × 1000 (protected asset's RTN frame at TCA)"},
]

# Input groups for per-alert explanations: each group is replaced together by its training median.
LIVE_GROUPS = {
    "miss": ["miss_distance_m", "miss_over_sigma"],
    "radial": ["radial_sep_m"],
    "uncertainty": ["sigma_km"],
    "pc": ["log10_pc"],
    "speed": ["relative_speed_ms"],
    "time": ["time_to_tca_d"],
    "type": ["object_type"],
}

# Columns whose history we summarise (value at first CDM, last change, slope per day toward TCA).
TREND_COLUMNS = [
    "risk", "max_risk_estimate", "miss_distance", "mahalanobis_distance",
    "c_position_covariance_det", "t_position_covariance_det", "c_sigma_r", "c_sigma_t", "c_sigma_n",
    "c_obs_used", "relative_speed",
]


# =========================================================================== feature construction (training)


def _isotropic_sigma_km(df) -> np.ndarray:
    """Combined isotropic-equivalent 1-sigma position error (km) from per-object R/T/N sigmas (m)."""
    cols = [f"{o}_sigma_{a}" for o in "ct" for a in "rtn"]
    sq = sum(df[c].to_numpy(float) ** 2 for c in cols)
    return np.sqrt(sq / 3.0) / 1000.0


def _slopes(d, col: str, t_col: str = "t_days"):
    """Per-event least-squares slope of `col` vs elapsed days, NaN if < 2 valid points."""
    sub = d[["event_id", t_col, col]].dropna()
    sub = sub.assign(tt=sub[t_col] ** 2, ty=sub[t_col] * sub[col])
    g = sub.groupby("event_id")
    n = g.size()
    sx, sy, sxy, sxx = g[t_col].sum(), g[col].sum(), g["ty"].sum(), g["tt"].sum()
    den = n * sxx - sx**2
    slope = (n * sxy - sx * sy) / den.where(den.abs() > 1e-9)
    return slope.where(n >= 2)


def build_event_table(df, min_days: float = MIN_TCA_DAYS):
    """One row per event from CDMs with time_to_tca >= min_days. Returns (feature DataFrame, latest-risk Series)."""
    import pandas as pd

    d = df[df["time_to_tca"] >= min_days].sort_values(["event_id", "time_to_tca"], ascending=[True, False]).copy()
    g = d.groupby("event_id", sort=True)
    d["rev"] = g.cumcount(ascending=False)  # 0 = latest CDM at least min_days out
    d["t_days"] = d.groupby("event_id")["time_to_tca"].transform("max") - d["time_to_tca"]  # elapsed since first CDM

    latest = d[d["rev"] == 0].set_index("event_id")
    prev = d[d["rev"] == 1].set_index("event_id").reindex(latest.index)
    first = d.groupby("event_id").head(1).set_index("event_id").reindex(latest.index)

    skip = {"event_id", "c_object_type", "rev", "t_days"}
    cols: dict = {c: latest[c].astype(float) for c in latest.columns if c not in skip}
    cols["object_type"] = latest["c_object_type"].map(OBJECT_CODES).astype(float)
    sigma = pd.Series(_isotropic_sigma_km(latest), index=latest.index)
    cols["sigma_km"] = sigma
    cols["miss_over_sigma"] = latest["miss_distance"] / (1000.0 * sigma.where(sigma > 0))
    cols["n_cdm"] = d.groupby("event_id").size().reindex(latest.index).astype(float)
    cols["span_days"] = latest["t_days"].astype(float)
    cols["risk_min"] = d.groupby("event_id")["risk"].min().reindex(latest.index)
    cols["risk_max"] = d.groupby("event_id")["risk"].max().reindex(latest.index)
    for c in TREND_COLUMNS:
        if c not in latest.columns:
            continue
        cols[f"{c}_first"] = first[c].astype(float)
        cols[f"{c}_delta"] = (latest[c] - prev[c]).astype(float)
        cols[f"{c}_slope"] = _slopes(d, c).reindex(latest.index)
    feats = pd.DataFrame(cols, index=latest.index).rename(columns={"time_to_tca": "time_to_tca_d", "risk": "latest_risk"})
    return feats, latest["risk"].astype(float)


def live_matrix(feats, names: list[str]):
    """Live-model inputs from an event table (the Kelvins side of LIVE_FEATURE_MAP), in `names` order."""
    import pandas as pd

    src = {
        "miss_distance_m": feats["miss_distance"],
        "relative_speed_ms": feats["relative_speed"],
        "time_to_tca_d": feats["time_to_tca_d"],
        "log10_pc": feats["latest_risk"],
        "sigma_km": feats["sigma_km"],
        "miss_over_sigma": feats["miss_over_sigma"],
        "object_type": feats["object_type"],
        "radial_sep_m": feats["relative_position_r"].abs(),
    }
    return pd.DataFrame({n: src[n] for n in names}, index=feats.index)


def final_risk_by_event(df):
    last = df.sort_values(["event_id", "time_to_tca"], ascending=[True, False]).groupby("event_id").tail(1).set_index("event_id")
    return last["risk"].astype(float), last["time_to_tca"].astype(float)


# =========================================================================== metrics


def _f_beta(p: float, r: float, beta: float) -> float:
    return (1 + beta**2) * p * r / (beta**2 * p + r) if (p + r) > 0 else 0.0


def ece(y: np.ndarray, p: np.ndarray) -> float:
    """Expected calibration error over the fixed CAL_EDGES bins: Σ (n_bin / n) · |mean predicted − observed rate|."""
    out = 0.0
    for lo, hi in zip(CAL_EDGES[:-1], CAL_EDGES[1:]):
        m = (p >= lo) & (p < hi)
        if m.any():
            out += m.mean() * abs(float(p[m].mean()) - float(y[m].mean()))
    return float(out)


def score_set(y_true: np.ndarray, pred_risk: np.ndarray, p_high: np.ndarray, pred_high: np.ndarray, rank_score: np.ndarray) -> dict:
    """All requested metrics. y_true / pred_risk are log10 risk; p_high in [0,1]; pred_high is the 0/1 decision."""
    from sklearn.metrics import average_precision_score, roc_auc_score

    y = (y_true >= HIGH_RISK).astype(int)
    pred = pred_high.astype(int)
    tp, fp = int(((pred == 1) & (y == 1)).sum()), int(((pred == 1) & (y == 0)).sum())
    fn, tn = int(((pred == 0) & (y == 1)).sum()), int(((pred == 0) & (y == 0)).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f2 = _f_beta(prec, rec, 2.0)
    hr = y == 1
    # Official Kelvins MSE: high-risk events only, with predictions clipped below at -6 (everything under -6 is
    # "low risk"). This reproduces the published latest-risk baseline exactly (MSE 0.513, L 0.694 on the test set).
    mse_hr = float(np.mean((np.clip(pred_risk[hr], HIGH_RISK, None) - y_true[hr]) ** 2)) if hr.any() else float("nan")
    mse_hr_raw = float(np.mean((pred_risk[hr] - y_true[hr]) ** 2)) if hr.any() else float("nan")
    both = 0 < y.sum() < len(y)
    ap = float(average_precision_score(y, rank_score)) if both else float("nan")
    return {
        "n": int(len(y)),
        "n_high_risk": int(y.sum()),
        "prevalence": float(y.mean()) if len(y) else float("nan"),  # share of high-risk events = PR-AUC of a random ranking
        "brier": float(np.mean((p_high - y) ** 2)),
        "ece": ece(y, p_high),
        "roc_auc": float(roc_auc_score(y, rank_score)) if both else float("nan"),
        "avg_precision": ap,
        "pr_auc": ap,  # area under the precision-recall curve, step-wise (average precision)
        "precision": prec,
        "recall": rec,
        "f1": _f_beta(prec, rec, 1.0),
        "f2": f2,
        "false_alert_rate": fp / (fp + tn) if fp + tn else 0.0,  # false positives / all low-risk events
        "false_alerts_per_1000": 1000.0 * fp / len(y),
        "alerts": tp + fp,
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "mse_log_risk": float(np.mean((pred_risk - y_true) ** 2)),
        "mse_high_risk": mse_hr,
        "mse_high_risk_unclipped": mse_hr_raw,
        # Official Kelvins loss L = MSE_HR / F2 (lower is better).
        "official_score": (mse_hr / f2) if f2 > 0 else float("inf"),
    }


def calibration_table(y_true: np.ndarray, p: np.ndarray) -> list[dict]:
    y = (y_true >= HIGH_RISK).astype(float)
    rows = []
    for lo, hi in zip(CAL_EDGES[:-1], CAL_EDGES[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum():
            rows.append({"bin": f"{lo:.2f}–{min(hi, 1.0):.2f}", "n": int(m.sum()), "mean_predicted": float(p[m].mean()), "observed_rate": float(y[m].mean()), "positives": int(y[m].sum())})
    return rows


def bootstrap_ci(y_true, preds: dict[str, dict], n_boot: int = 600, seed: int = SEED) -> dict:
    """95% bootstrap CIs (resampling events) for key metrics, and for each model's difference to the baseline."""
    rng = np.random.default_rng(seed)
    n = len(y_true)
    keys = ["brier", "roc_auc", "f2", "recall", "mse_high_risk", "official_score"]
    draws: dict[str, dict[str, list[float]]] = {m: {k: [] for k in keys} for m in preds}
    for _ in range(n_boot):
        idx = rng.integers(0, n, n)
        if (y_true[idx] >= HIGH_RISK).sum() < 3:
            continue
        for m, p in preds.items():
            s = score_set(y_true[idx], p["risk"][idx], p["p"][idx], p["high"][idx], p["rank"][idx])
            for k in keys:
                draws[m][k].append(s[k])
    out: dict = {"n_boot": n_boot, "models": {}, "vs_baseline": {}}
    for m in preds:
        out["models"][m] = {k: _ci(draws[m][k]) for k in keys}
        if m != "baseline":
            out["vs_baseline"][m] = {k: _ci(np.array(draws[m][k]) - np.array(draws["baseline"][k])) for k in keys}
    return out


def _ci(v) -> dict:
    a = np.asarray(v, dtype=float)
    a = a[np.isfinite(a)]
    if len(a) < 20:
        return {"lo": None, "hi": None}
    return {"lo": float(np.percentile(a, 2.5)), "hi": float(np.percentile(a, 97.5))}


# =========================================================================== training


def operating_threshold(y: np.ndarray, p: np.ndarray, target_recall: float = TARGET_RECALL) -> tuple[float, dict]:
    """Highest threshold whose recall on these (validation) events is >= target_recall.

    If that would need a threshold of 0 (alerting on every event), use the lowest non-zero probability of a
    high-risk event instead and report the recall actually reached.
    """
    pos = np.sort(p[y == 1])[::-1]
    k = max(int(math.ceil(target_recall * len(pos))), 1)
    t = float(pos[min(k, len(pos)) - 1])
    if t <= 0.0:
        nz = pos[pos > 0]
        t = float(nz[-1]) if len(nz) else 1e-9
    pred = p >= t
    tp, fp = int((pred & (y == 1)).sum()), int((pred & (y == 0)).sum())
    neg = int((y == 0).sum())
    rec = tp / max(int((y == 1).sum()), 1)
    return t, {"threshold": t, "recall": rec, "target_recall": target_recall, "reached": rec >= target_recall,
               "false_alert_rate": fp / neg if neg else 0.0, "alerts": tp + fp, "n": int(len(y)), "n_high_risk": int((y == 1).sum())}


def _make_clf(depth: int, iters: int, cat_idx: list[int], class_weight: str | None = None):
    from sklearn.ensemble import HistGradientBoostingClassifier

    return HistGradientBoostingClassifier(
        learning_rate=0.05, max_depth=depth, max_iter=iters, min_samples_leaf=30, l2_regularization=1.0,
        categorical_features=cat_idx or None, class_weight=class_weight, random_state=SEED,
    )


def _make_reg(depth: int, iters: int, cat_idx: list[int]):
    from sklearn.ensemble import HistGradientBoostingRegressor

    return HistGradientBoostingRegressor(
        learning_rate=0.05, max_depth=depth, max_iter=iters, min_samples_leaf=30, l2_regularization=1.0,
        categorical_features=cat_idx or None, random_state=SEED,
    )


def _kfold():
    from sklearn.model_selection import KFold

    return KFold(5, shuffle=True, random_state=SEED)


def tune_classifier(X: np.ndarray, y: np.ndarray, cat_idx: list[int]) -> tuple[int, int]:
    """Depth / iterations by 5-fold CV log-loss on the training events only (unweighted)."""
    from sklearn.metrics import log_loss
    from sklearn.model_selection import StratifiedKFold, cross_val_predict

    cv = StratifiedKFold(5, shuffle=True, random_state=SEED)
    best = None
    for depth in (2, 3, 4):
        for iters in (100, 250):
            oof = cross_val_predict(_make_clf(depth, iters, cat_idx), X, y, cv=cv, method="predict_proba")[:, 1]
            ll = log_loss(y, np.clip(oof, 1e-6, 1 - 1e-6))
            if best is None or ll < best[0]:
                best = (ll, depth, iters)
    return best[1], best[2]


def fit_classifier(X: np.ndarray, y: np.ndarray, cat_idx: list[int], depth: int, iters: int, class_weight: str | None):
    """Isotonic-calibrated classifier. With class_weight="balanced" the trees are trained on balanced weights, but
    the isotonic calibrator is fitted on UNWEIGHTED held-out folds, so the output is recalibrated to real frequencies."""
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.model_selection import StratifiedKFold

    cal = CalibratedClassifierCV(_make_clf(depth, iters, cat_idx, class_weight), method="isotonic", cv=StratifiedKFold(CAL_FOLDS, shuffle=True, random_state=SEED))
    return cal.fit(X, y)


def fit_regressors(X: np.ndarray, y_final: np.ndarray, latest: np.ndarray, cat_idx: list[int]) -> dict:
    """Regressor of the change from the latest risk (all events), plus one trained only on high-risk events."""
    from sklearn.model_selection import KFold, cross_val_predict

    resid = y_final - latest
    best_r = None
    for rdepth in (2, 3, 4):
        for riters in (100, 250):
            oof_r = cross_val_predict(_make_reg(rdepth, riters, cat_idx), X, resid, cv=_kfold())
            mse = float(np.mean((latest + oof_r - y_final) ** 2))
            if best_r is None or mse < best_r[0]:
                best_r = (mse, rdepth, riters)
    _, rdepth, riters = best_r
    reg = _make_reg(rdepth, riters, cat_idx).fit(X, resid)

    # High-risk regressor: trained ONLY on events whose final risk is high, predicting the change from the
    # latest risk (floored at -6). It is used for events the classifier flags. The shrink weight alpha
    # (0 = plain baseline, 1 = full regressor) is chosen by cross-validation on those training events only.
    hr = y_final >= HIGH_RISK
    base_hr = np.clip(latest[hr], HIGH_RISK, None)
    resid_hr = y_final[hr] - base_hr
    Xh = X[hr]
    oof_h = np.zeros(hr.sum())
    for tr_i, va_i in KFold(5, shuffle=True, random_state=SEED).split(Xh):
        m = _make_reg(2, 60, cat_idx)
        m.set_params(min_samples_leaf=8)
        oof_h[va_i] = m.fit(Xh[tr_i], resid_hr[tr_i]).predict(Xh[va_i])
    alphas = (0.0, 0.25, 0.5, 0.75, 1.0)
    cv_mse = {a: float(np.mean((base_hr + a * oof_h - y_final[hr]) ** 2)) for a in alphas}
    alpha = min(cv_mse, key=cv_mse.get)
    reg_hr = _make_reg(2, 60, cat_idx)
    reg_hr.set_params(min_samples_leaf=8)
    reg_hr.fit(Xh, resid_hr)
    return {"reg": reg, "reg_hr": reg_hr, "alpha_hr": alpha,
            "reg_hyper": {"reg_depth": rdepth, "reg_iters": riters, "hr_alpha": alpha, "hr_cv_mse_by_alpha": cv_mse, "hr_train_events": int(hr.sum())}}


def _medians(X: np.ndarray, names: list[str], cat_names: list[str]) -> list[float]:
    """Training reference values for explanations: median per input (most common value for categorical inputs)."""
    out = []
    for j, n in enumerate(names):
        col = X[:, j][np.isfinite(X[:, j])]
        if not len(col):
            out.append(float("nan"))
        elif n in cat_names:
            vals, counts = np.unique(col, return_counts=True)
            out.append(float(vals[np.argmax(counts)]))
        else:
            out.append(float(np.median(col)))
    return out


def predict_family(m: dict, X: np.ndarray, latest: np.ndarray, threshold: float | None = None) -> dict:
    p = m["clf"].predict_proba(X)[:, 1]
    high = p >= (m["threshold"] if threshold is None else threshold)
    risk = np.clip(latest + m["reg"].predict(X), RISK_FLOOR, -1.0)  # all-event estimate
    # Events flagged high-risk get the high-risk regressor's estimate (never below the -6 threshold).
    risk_hr = np.clip(np.clip(latest, HIGH_RISK, None) + m["alpha_hr"] * m["reg_hr"].predict(X), HIGH_RISK, -1.0)
    risk = np.where(high, risk_hr, risk)
    return {"p": p, "risk": risk, "high": high, "rank": p}


def baseline_predictions(latest: np.ndarray) -> dict:
    high = latest >= HIGH_RISK
    return {"p": high.astype(float), "risk": latest, "high": high, "rank": latest}


def importance(m: dict, X: np.ndarray, y_final: np.ndarray, top: int = 15) -> list[dict]:
    """Permutation importance of the calibrated classifier: rise in Brier score when a feature is shuffled."""
    from sklearn.inspection import permutation_importance

    y = (y_final >= HIGH_RISK).astype(int)
    r = permutation_importance(m["clf"], X, y, scoring="neg_brier_score", n_repeats=8, random_state=SEED, n_jobs=1)
    order = np.argsort(-r.importances_mean)[:top]
    return [{"feature": m["names"][i], "importance": float(r.importances_mean[i]), "std": float(r.importances_std[i])} for i in order]


def _brief(s: dict) -> dict:
    keys = ("n", "n_high_risk", "prevalence", "brier", "ece", "pr_auc", "roc_auc", "recall", "false_alert_rate", "precision", "alerts", "official_score")
    return {k: s[k] for k in keys}


def prepare(data_dir: Path = DATA_DIR) -> dict:
    """Load the Kelvins CSVs, build one row per event and make the fixed-seed 60/20/20 split by event."""
    import pandas as pd
    from sklearn.model_selection import train_test_split

    print("loading CSVs…", flush=True)
    tr = pd.read_csv(data_dir / "train_data" / "train_data.csv", low_memory=False)
    te = pd.read_csv(data_dir / "test_data.csv", low_memory=False)
    pv = pd.read_csv(data_dir / "test_data_private.csv", low_memory=False)

    # ---- training events: inputs from CDMs >= 2 d out; target = risk of the event's last CDM
    feats_all, latest_all = build_event_table(tr)
    final, last_tca = final_risk_by_event(tr)
    y_final_all = final.reindex(feats_all.index)
    eligible = last_tca.reindex(feats_all.index) < MIN_TCA_DAYS  # the final CDM itself must be within 2 days
    feats_all, latest_all, y_final_all = feats_all[eligible], latest_all[eligible], y_final_all[eligible]
    n_events_total = tr["event_id"].nunique()
    print(f"events: {n_events_total} total, {len(feats_all)} eligible, {int((y_final_all >= HIGH_RISK).sum())} high-risk", flush=True)

    # ---- fixed-seed split by event (each row here is a whole event, so no event can be in two sets)
    ids = feats_all.index.to_numpy()
    strat = (y_final_all >= HIGH_RISK).astype(int)
    rest_ids, ho_ids = train_test_split(ids, test_size=HOLDOUT_FRACTION, random_state=SEED, stratify=strat.to_numpy())
    tr_ids, va_ids = train_test_split(rest_ids, test_size=VAL_FRACTION, random_state=SEED, stratify=strat.loc[rest_ids].to_numpy())
    assert not (set(tr_ids) & set(ho_ids)) and not (set(tr_ids) & set(va_ids)) and not (set(va_ids) & set(ho_ids))

    # ---- official test set (inputs) and labels (true_risk of the final CDM, from test_data_private.csv)
    feats_te, latest_te = build_event_table(te)
    y_te_s = pv.set_index("event_id")["true_risk"]
    y_te = y_te_s.reindex(feats_te.index).to_numpy(float)
    assert not np.isnan(y_te).any() and te["time_to_tca"].min() >= MIN_TCA_DAYS
    return {"tr": tr, "te": te, "feats_all": feats_all, "latest_all": latest_all, "y_final_all": y_final_all,
            "n_events_total": n_events_total, "tr_ids": tr_ids, "va_ids": va_ids, "ho_ids": ho_ids,
            "feats_te": feats_te, "latest_te": latest_te, "y_te": y_te, "y_te_s": y_te_s}


def train(data_dir: Path = DATA_DIR) -> dict:
    import joblib
    import sklearn

    t0 = time.time()
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    P = prepare(data_dir)
    tr, te = P["tr"], P["te"]
    feats_all, latest_all, y_final_all, n_events_total = P["feats_all"], P["latest_all"], P["y_final_all"], P["n_events_total"]
    tr_ids, va_ids, ho_ids = P["tr_ids"], P["va_ids"], P["ho_ids"]
    feats_te, latest_te, y_te, y_te_s = P["feats_te"], P["latest_te"], P["y_te"], P["y_te_s"]

    full_names = list(feats_all.columns)
    full_cat = ["mission_id", "object_type"]
    feature_sets = {
        "full": (full_names, full_cat),
        "live_base": (LIVE_FEATURES_BASE, LIVE_CATEGORICAL),
        "live_radial": (LIVE_FEATURES_RADIAL, LIVE_CATEGORICAL),
    }

    def matrix(fs: str, feats):
        names = feature_sets[fs][0]
        return (feats[names] if fs == "full" else live_matrix(feats, names)).to_numpy(float)

    def make_set(feats, latest, y):
        return {"X": {fs: matrix(fs, feats) for fs in feature_sets}, "latest": latest.to_numpy(float) if hasattr(latest, "to_numpy") else latest, "y": y}

    data = {
        "train": make_set(feats_all.loc[tr_ids], latest_all.loc[tr_ids], y_final_all.loc[tr_ids].to_numpy(float)),
        "validation": make_set(feats_all.loc[va_ids], latest_all.loc[va_ids], y_final_all.loc[va_ids].to_numpy(float)),
        "holdout": make_set(feats_all.loc[ho_ids], latest_all.loc[ho_ids], y_final_all.loc[ho_ids].to_numpy(float)),
        "official_test": make_set(feats_te, latest_te, y_te),
    }
    eval_sets = ("holdout", "official_test")
    ytr = data["train"]["y"]
    ytr_bin = (ytr >= HIGH_RISK).astype(int)
    yva_bin = (data["validation"]["y"] >= HIGH_RISK).astype(int)
    print(f"split: train {len(tr_ids)} ({ytr_bin.sum()} high-risk) / validation {len(va_ids)} ({yva_bin.sum()}) / held-out test {len(ho_ids)} "
          f"({int((data['holdout']['y'] >= HIGH_RISK).sum())})", flush=True)

    # ---- fit every candidate: 3 feature sets × {unweighted, balanced class weights + isotonic recalibration}
    variants: dict[str, dict[str, dict]] = {}
    imbalance: dict[str, dict] = {}
    for fs, (names, cat_names) in feature_sets.items():
        cat_idx = [names.index(c) for c in cat_names if c in names]
        Xtr = data["train"]["X"][fs]
        Xva = data["validation"]["X"][fs]
        depth, iters = tune_classifier(Xtr, ytr_bin, cat_idx)
        regs = fit_regressors(Xtr, ytr, data["train"]["latest"], cat_idx)
        medians = _medians(Xtr, names, cat_names)
        variants[fs] = {}
        imbalance[fs] = {}
        for cw in (None, "balanced"):
            clf = fit_classifier(Xtr, ytr_bin, cat_idx, depth, iters, cw)
            fam = {"clf": clf, **{k: regs[k] for k in ("reg", "reg_hr", "alpha_hr")}, "names": list(names), "cat_names": list(cat_names),
                   "medians": medians, "class_weight": cw or "none",
                   "hyper": {"clf_depth": depth, "clf_iters": iters, "class_weight": cw or "none", **regs["reg_hyper"]}}
            pva = clf.predict_proba(Xva)[:, 1]
            fam["threshold"], fam["validation_operating_point"] = operating_threshold(yva_bin, pva)
            key = cw or "none"
            variants[fs][key] = fam
            imbalance[fs][key] = {"validation_brier": float(np.mean((pva - yva_bin) ** 2)), "validation_ece": ece(yva_bin, pva),
                                  "validation_pr_auc": score_set(data["validation"]["y"], pva, pva, pva >= fam["threshold"], pva)["pr_auc"],
                                  "threshold": fam["threshold"], "validation_false_alert_rate": fam["validation_operating_point"]["false_alert_rate"]}
        # For context only: the weighted trees WITHOUT recalibration (raw probabilities are inflated).
        raw = _make_clf(depth, iters, cat_idx, "balanced").fit(Xtr, ytr_bin)
        praw = raw.predict_proba(Xva)[:, 1]
        imbalance[fs]["balanced_uncalibrated"] = {"validation_brier": float(np.mean((praw - yva_bin) ** 2)), "validation_ece": ece(yva_bin, praw)}
        # Keep the better-calibrated variant (lower validation Brier score; calibration error shown alongside).
        imbalance[fs]["chosen"] = min(("none", "balanced"), key=lambda k: imbalance[fs][k]["validation_brier"])
        print(f"  {fs}: depth {depth}, {iters} iters | val Brier none {imbalance[fs]['none']['validation_brier']:.5f} "
              f"balanced {imbalance[fs]['balanced']['validation_brier']:.5f} (raw {imbalance[fs]['balanced_uncalibrated']['validation_brier']:.5f}) "
              f"-> {imbalance[fs]['chosen']} | {time.time()-t0:.0f}s", flush=True)

    chosen = {fs: variants[fs][imbalance[fs]["chosen"]] for fs in feature_sets}
    # Radial separation: use it in the live model only if it does not worsen the validation Brier score.
    radial_used = imbalance["live_radial"][imbalance["live_radial"]["chosen"]]["validation_brier"] <= imbalance["live_base"][imbalance["live_base"]["chosen"]]["validation_brier"]
    live_key = "live_radial" if radial_used else "live_base"
    full, live = chosen["full"], chosen[live_key]
    print(f"live model: {'with' if radial_used else 'without'} radial separation", flush=True)

    def preds_for(ds: str) -> dict:
        d = data[ds]
        return {"baseline": baseline_predictions(d["latest"]), "full": predict_family(full, d["X"]["full"], d["latest"]),
                "live": predict_family(live, d["X"][live_key], d["latest"])}

    results, calib, intervals = {}, {}, {}
    for ds in eval_sets:
        preds = preds_for(ds)
        results[ds] = {m: score_set(data[ds]["y"], p["risk"], p["p"], p["high"], p["rank"]) for m, p in preds.items()}
        calib[ds] = {m: calibration_table(data[ds]["y"], preds[m]["p"]) for m in ("full", "live")}
        intervals[ds] = bootstrap_ci(data[ds]["y"], preds)

    # ---- radial comparison: both live feature sets (each with its own chosen weighting) on every set
    radial_cmp = {"used": radial_used, "rule": "kept only if the validation Brier score is not worse", "by_set": {}}
    for fs in ("live_base", "live_radial"):
        m = chosen[fs]
        radial_cmp["by_set"][fs] = {"validation": {"brier": imbalance[fs][imbalance[fs]["chosen"]]["validation_brier"], **{k: m["validation_operating_point"][k] for k in ("threshold", "recall", "false_alert_rate")}}}
        for ds in eval_sets:
            p = predict_family(m, data[ds]["X"][fs], data[ds]["latest"])
            radial_cmp["by_set"][fs][ds] = _brief(score_set(data[ds]["y"], p["risk"], p["p"], p["high"], p["rank"]))

    # ---- imbalance comparison on the test sets too (both variants, for transparency; the choice used validation only)
    for fs in feature_sets:
        for key in ("none", "balanced"):
            m = variants[fs][key]
            for ds in eval_sets:
                p = predict_family(m, data[ds]["X"][fs], data[ds]["latest"])
                s = score_set(data[ds]["y"], p["risk"], p["p"], p["high"], p["rank"])
                imbalance[fs][key][ds] = {k: s[k] for k in ("brier", "ece", "pr_auc", "recall", "false_alert_rate")}

    # ---- lead time: truncate inputs to CDMs at least L days before TCA (same events, same targets, same thresholds)
    lead = {"holdout": [], "official_test": []}
    sources = {"holdout": (tr[tr["event_id"].isin(ho_ids)], y_final_all), "official_test": (te, y_te_s)}
    for ds, (df, ys) in sources.items():
        for L in LEAD_DAYS:
            f, lt = build_event_table(df, min_days=L)
            if not len(f):
                continue
            y = ys.reindex(f.index).to_numpy(float)
            ok = ~np.isnan(y)
            f, lt, y = f[ok], lt[ok], y[ok]
            row = {"days": L, "label": f"≥ {L:g} d" if L < LEAD_DAYS[-1] else f"{L:g}+ d", "n": int(len(y)), "n_high_risk": int((y >= HIGH_RISK).sum())}
            for name, p in (("baseline", baseline_predictions(lt.to_numpy(float))),
                            ("full", predict_family(full, matrix("full", f), lt.to_numpy(float))),
                            ("live", predict_family(live, matrix(live_key, f), lt.to_numpy(float)))):
                s = score_set(y, p["risk"], p["p"], p["high"], p["rank"])
                row[name] = {k: s[k] for k in ("recall", "brier", "false_alert_rate", "pr_auc", "tp", "fn")}
            lead[ds].append(row)

    imp = {
        "full": importance(full, data["holdout"]["X"]["full"], data["holdout"]["y"]),
        "live": importance(live, data["holdout"]["X"][live_key], data["holdout"]["y"], top=len(live["names"])),
    }

    decision_levels = decision_level_kpis(_eval_sets(P), live)

    sizes = {}
    for name, m in (("full", full), ("live", live)):
        joblib.dump(m, MODEL_DIR / f"{name}.joblib", compress=3)
        sizes[name] = (MODEL_DIR / f"{name}.joblib").stat().st_size

    previous = _clean(json.loads(METRICS_PATH.read_text(encoding="utf-8"))) if METRICS_PATH.exists() else {}
    metrics = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "seed": SEED,
        "versions": {"scikit_learn": sklearn.__version__, "numpy": np.__version__},
        "dataset": {
            "name": "ESA Collision Avoidance Challenge (Kelvins)", "url": KELVINS_URL, "paper": PAPER_URL, "years": "2015–2019",
            "description": "Conjunction Data Messages (CDMs) received by ESA's Space Debris Office for its satellites, anonymised.",
            "train_events": int(n_events_total), "train_events_eligible": int(len(feats_all)),
            "train_high_risk_events": int((y_final_all >= HIGH_RISK).sum()),
            "official_test_events": int(len(feats_te)), "official_test_high_risk_events": int((y_te >= HIGH_RISK).sum()),
            "note": "The official test set was hand-picked to over-represent high-risk events (6.9% vs ~1% in the eligible training events), so Brier scores and calibration differ between the two evaluations.",
        },
        "task": {
            "target": "risk (log10) in the last CDM of the event", "inputs": "CDMs with time_to_tca >= 2 days only",
            "high_risk": "final risk >= -6 (collision probability >= 1e-6)",
            "eligibility": "training events need >= 1 CDM at >= 2 days and a final CDM within 2 days of TCA",
        },
        "split": {"train_events": int(len(tr_ids)), "train_high_risk": int(ytr_bin.sum()),
                  "validation_events": int(len(va_ids)), "validation_high_risk": int(yva_bin.sum()),
                  "holdout_events": int(len(ho_ids)), "holdout_high_risk": int((data["holdout"]["y"] >= HIGH_RISK).sum()), "seed": SEED,
                  "rule": "by event, stratified on high-risk: 60% train / 20% validation (all choices) / 20% held-out test (reporting only)"},
        "models": {
            "baseline": "Latest risk prediction: final risk = risk of the latest CDM at least 2 days from TCA; high-risk if that risk >= -6.",
            "full": "HistGradientBoosting; isotonic-calibrated classifier + two regressors of the change from the latest risk: one over all events, one trained only on high-risk events and used for flagged events (shrunk toward the baseline by a cross-validated weight).",
            "live": "Same model families restricted to the inputs our live screener produces (see feature_mapping).",
        },
        "thresholds": {"full": full["threshold"], "live": live["threshold"],
                       "rule": f"highest probability that still catches ≥ {TARGET_RECALL:.0%} of the high-risk VALIDATION events"},
        "hyperparameters": {"full": full["hyper"], "live": live["hyper"]},
        "n_features": {"full": len(full_names), "live": len(live["names"])},
        "live_features": live["names"],
        "feature_mapping": [f for f in LIVE_FEATURE_MAP if f["feature"] in live["names"]],
        "results": results,
        "intervals": intervals,
        "calibration": calib,
        "importance": imp,
        "kpis": {
            "operating_point": {"rule": f"threshold chosen on the validation split for ≥ {TARGET_RECALL:.0%} recall on high-risk events",
                                "target_recall": TARGET_RECALL, "validation": {"full": full["validation_operating_point"], "live": live["validation_operating_point"]}},
            "lead_time": {"method": "inputs truncated to CDMs at least L days before TCA; same events (those with such a CDM), same targets and thresholds", "rows": lead},
            "class_imbalance": {"before": "not handled: unweighted classifier, isotonic calibration",
                                "tried": "class_weight='balanced' trees, then isotonic recalibration on unweighted held-out folds",
                                "selection": "lower validation Brier score (calibration error also shown)", "by_feature_set": imbalance},
            "radial_feature": radial_cmp,
            "decision_levels": decision_levels,
            # Throughput is measured by `python ml.py throughput` on the live catalog; kept across retrains.
            "throughput": previous.get("kpis", {}).get("throughput"),
        },
        # LSTM benchmark from `python ml.py lstm`; kept across retrains (trees_trained_utc says which trees it compared).
        "model_comparison": previous.get("model_comparison"),
        "published": PUBLISHED,
        "model_files_bytes": sizes,
        "train_seconds": round(time.time() - t0, 1),
    }
    metrics["verdict"] = verdict(metrics)
    METRICS_PATH.write_text(json.dumps(_clean(metrics), indent=2), encoding="utf-8")
    print(f"saved models + metrics to {MODEL_DIR} ({sum(sizes.values())/1e6:.2f} MB of models, {time.time()-t0:.0f}s)", flush=True)
    return metrics


def _eval_sets(P: dict) -> dict:
    """(features, latest risk, final risk) for the held-out events and ESA's official test set."""
    ho = P["ho_ids"]
    return {
        "holdout": (P["feats_all"].loc[ho], P["latest_all"].loc[ho].to_numpy(float), P["y_final_all"].loc[ho].to_numpy(float)),
        "official_test": (P["feats_te"], P["latest_te"].to_numpy(float), P["y_te"]),
    }


def _confusion(y_high: np.ndarray, pred: np.ndarray) -> dict:
    tp, fp = int((pred & y_high).sum()), int((pred & ~y_high).sum())
    fn, tn = int((~pred & y_high).sum()), int((~pred & ~y_high).sum())
    return {"recall": tp / (tp + fn) if tp + fn else None, "false_alert_rate": fp / (fp + tn) if fp + tn else None,
            "precision": tp / (tp + fp) if tp + fp else None, "alerts": tp + fp, "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def decision_level_kpis(sets: dict, live: dict) -> dict:
    """Recall / false-alert rate of the two-stage Go / No-Go rule (decision.triggers) on ESA events.

    Mapping (ESA CDM → live record): Pc = 10^risk of the latest CDM ≥ 2 d before TCA, miss = miss_distance; AI inputs
    as in LIVE_FEATURE_MAP. Truth: final risk ≥ 1e-6. ESA CDMs carry no TLE age, so the stale-data rule never fires.
    "WATCH or above" = any GO or WATCH trigger (GO also needs a valid avoidance plan, which cannot be checked on
    historical data; without one, GO becomes WATCH, so the count is the same).
    """
    import decision

    cfg = {**decision.CONFIG, "ai_p_high_threshold": float(live["threshold"])}
    out: dict = {
        "method": ("Pc = 10^risk of the latest ESA CDM at least 2 days before TCA; miss = its miss_distance; AI = live model on the "
                   "same CDM. Truth: final risk ≥ 1e-6. ESA CDMs carry no TLE age, so the stale-data rule never fires. GO also needs "
                   "a valid avoidance plan, which cannot be checked on historical data; without one GO becomes WATCH, so "
                   "'WATCH or above' counts every GO or WATCH trigger."),
        "thresholds": {k: cfg[k] for k in ("ai_p_high_threshold", "watch_pc", "watch_ai_min_pc", "go_pc", "go_ai_final_risk")},
        "levels": {
            "early_flag": "AI early flag: P(high-risk) ≥ the 95%-recall threshold (tag only)",
            "watch_or_above": "WATCH or above under the two-stage rule",
            "pc_watch_only": "For comparison: Pc ≥ 1e-5 alone (no AI)",
            "previous_rule": "For comparison: the previous rule (AI flag alone, or Pc / AI final risk ≥ 1e-5, raised WATCH)",
        },
        "by_set": {},
    }
    for ds, (feats, latest, y) in sets.items():
        X = live_matrix(feats, live["names"]).to_numpy(float)
        pred = predict_family(live, X, latest)
        pc = 10.0 ** np.asarray(latest, float)
        miss_km = feats["miss_distance"].to_numpy(float) / 1000.0
        ai_risk = 10.0 ** pred["risk"]
        y_high = np.asarray(y, float) >= HIGH_RISK
        n = len(y)
        flag = np.zeros(n, bool)
        woa = np.zeros(n, bool)
        go_ai_only = np.zeros(n, bool)
        by_trigger = {"pc": 0, "ai_backed_by_pc": 0, "go_threshold": 0}
        for i in range(n):
            t = decision.triggers(float(pc[i]), float(pred["p"][i]), float(ai_risk[i]), None, float(miss_km[i]), cfg)
            flag[i] = t["ai_flag"]
            woa[i] = bool(t["go"] or t["watch"])
            go_ai_only[i] = bool(t["go"]) and pc[i] < cfg["go_pc"]
            if t["go"]:
                by_trigger["go_threshold"] += 1
            elif any(r.startswith("Pc ") for r in t["watch"]):
                by_trigger["pc"] += 1
            elif t["watch"]:
                by_trigger["ai_backed_by_pc"] += 1
        previous = flag | (pc >= 1e-5) | (ai_risk >= 1e-5)
        out["by_set"][ds] = {
            "n": n, "n_high_risk": int(y_high.sum()),
            "early_flag": _confusion(y_high, flag),
            "watch_or_above": _confusion(y_high, woa),
            "pc_watch_only": _confusion(y_high, pc >= cfg["watch_pc"]),
            "previous_rule": _confusion(y_high, previous),
            "early_flag_only": int((flag & ~woa).sum()),
            "watch_or_above_by_trigger": by_trigger,
            "go_from_ai_only": int(go_ai_only.sum()),
        }
    return out


def measure_decision_kpis() -> dict:
    """Recompute kpis.decision_levels from the saved live model (no retraining) and save it in metrics.json."""
    import joblib

    live = joblib.load(MODEL_DIR / "live.joblib")
    result = decision_level_kpis(_eval_sets(prepare()), live)
    m = json.loads(METRICS_PATH.read_text(encoding="utf-8")) if METRICS_PATH.exists() else {}
    m.setdefault("kpis", {})["decision_levels"] = result
    METRICS_PATH.write_text(json.dumps(_clean(m), indent=2), encoding="utf-8")
    print(json.dumps(_clean(result["by_set"]), indent=2), flush=True)
    return result


def measure_throughput() -> dict:
    """Screen the ISS, the Sentinel watchlist and an all-vs-all slice over 72 h (risk.benchmark); save in metrics.json."""
    import orbit
    import risk
    import watchlist

    entries, meta = orbit.build_catalog()
    by = {e["norad"]: e for e in entries}
    watchlist.sync_defaults(by)
    watched, _ = watchlist.resolve(by)
    print(f"catalog: {len(entries)} objects from {meta.get('source')}; watchlist {len(watched)}; screening over 72 h…", flush=True)
    result = risk.benchmark(risk.build_index(entries), [w["entry"] for w in watched])
    result["catalog_source"] = meta.get("source")
    m = json.loads(METRICS_PATH.read_text(encoding="utf-8")) if METRICS_PATH.exists() else {}
    m.setdefault("kpis", {})["throughput"] = result
    METRICS_PATH.write_text(json.dumps(_clean(m), indent=2), encoding="utf-8")
    print(json.dumps({k: result.get(k) for k in ("reference", "watchlist", "all_vs_all_estimate")}, indent=2), flush=True)
    return result


def _clean(o):
    """Recursively turn NaN/Infinity (invalid JSON) into None and numpy scalars into Python numbers."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.generic):
        o = o.item()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def verdict(m: dict) -> dict:
    """Plain statements on whether each model beats the baseline, based on the bootstrap intervals."""
    out = {}
    for ds in ("holdout", "official_test"):
        rs, iv = m["results"][ds], m["intervals"][ds]["vs_baseline"]
        out[ds] = {}
        for model in ("full", "live"):
            lines = []
            for key, label, lower_better in (("official_score", "Kelvins score L", True), ("brier", "Brier score", True), ("recall", "Recall", False),
                                             ("f2", "F2", False), ("mse_high_risk", "MSE on high-risk events", True)):
                d = iv[model][key]
                a, b = rs[model][key], rs["baseline"][key]
                if d["lo"] is None:
                    lines.append(f"{label}: not enough data for a confidence interval.")
                    continue
                better = (d["hi"] < 0) if lower_better else (d["lo"] > 0)
                worse = (d["lo"] > 0) if lower_better else (d["hi"] < 0)
                status = "better than the baseline" if better else "worse than the baseline" if worse else "not distinguishable from the baseline"
                lines.append(f"{label}: {a:.3g} vs baseline {b:.3g}; {status} (95% CI of the difference {d['lo']:.3g} to {d['hi']:.3g}).")
            out[ds][model] = lines
    return out


# =========================================================================== LSTM benchmark (`python ml.py lstm`)
#
# Benchmark only: a small LSTM over each event's CDM sequence vs the gradient-boosted trees, on the SAME events,
# split, inputs (CDMs >= 2 d before TCA) and target. Calibration mirrors the trees exactly: 5-fold cross-fitting on
# the training events, isotonic regression on each left-out fold, the 5 calibrated models averaged
# (= CalibratedClassifierCV(method="isotonic", cv=5)). Validation chooses the LSTM's settings and every threshold.
# The live model stays the trees unless the live-input LSTM beats them on validation (see benchmark_lstm).

LSTM_MAX_EPOCHS = 40
LSTM_HIDDEN = 64
LSTM_BATCH = 128
# Live-model input -> per-CDM column (the same mapping as live_matrix, applied to every CDM in the sequence).
LSTM_LIVE_COLUMNS = {"miss_distance_m": "miss_distance", "relative_speed_ms": "relative_speed", "time_to_tca_d": "time_to_tca",
                     "log10_pc": "risk", "sigma_km": "sigma_km", "miss_over_sigma": "miss_over_sigma", "radial_sep_m": "radial_sep_m"}


def _cdm_frame(df):
    """CDMs >= 2 d before TCA, oldest first per event, plus the derived per-CDM columns the event table uses."""
    d = df[df["time_to_tca"] >= MIN_TCA_DAYS].sort_values(["event_id", "time_to_tca"], ascending=[True, False]).reset_index(drop=True).copy()  # copy: de-fragment before adding columns
    sigma = _isotropic_sigma_km(d)
    d["sigma_km"] = sigma
    d["miss_over_sigma"] = d["miss_distance"] / (1000.0 * np.where(sigma > 0, sigma, np.nan))
    d["radial_sep_m"] = d["relative_position_r"].abs()
    d["object_type"] = d["c_object_type"].map(OBJECT_CODES).fillna(3).astype(int)
    return d


class _SeqPrep:
    """Per-CDM input scaling fitted on training CDMs: signed log for heavy-tailed columns (|p99| > 100), then
    z-score, clipped to ±8; missing -> 0 (the training mean). Categoricals one-hot (unknown mission -> all zero)."""

    def __init__(self, d, cols: list[str], missions: list[int] | None):
        self.cols, self.missions = cols, missions
        self.log, self.mu, self.sd = {}, {}, {}
        for c in cols:
            x = d[c].to_numpy(float)
            x = x[np.isfinite(x)]
            self.log[c] = bool(len(x)) and float(np.percentile(np.abs(x), 99)) > 100.0
            if self.log[c]:
                x = np.sign(x) * np.log1p(np.abs(x))
            self.mu[c] = float(x.mean()) if len(x) else 0.0
            sd = float(x.std()) if len(x) else 1.0
            self.sd[c] = sd if sd > 1e-9 else 1.0

    def transform(self, d) -> np.ndarray:
        blocks = []
        for c in self.cols:
            x = d[c].to_numpy(float)
            if self.log[c]:
                x = np.sign(x) * np.log1p(np.abs(x))
            blocks.append(np.clip((x - self.mu[c]) / self.sd[c], -8.0, 8.0))
        ot = d["object_type"].to_numpy(int)
        blocks += [(ot == k).astype(float) for k in range(4)]
        if self.missions is not None:
            mid = d["mission_id"].to_numpy()
            blocks += [(mid == m).astype(float) for m in self.missions]
        return np.nan_to_num(np.column_stack(blocks), nan=0.0).astype(np.float32)


def _padded(d, M: np.ndarray, ids) -> tuple[np.ndarray, np.ndarray]:
    """(events, max_len, features) zero-padded at the end, and each event's sequence length, in `ids` order."""
    ev = d["event_id"].to_numpy()
    starts = np.flatnonzero(np.r_[True, ev[1:] != ev[:-1]])
    ends = np.r_[starts[1:], len(ev)]
    span = {e: (s, t) for e, s, t in zip(ev[starts], starts, ends)}
    lengths = np.array([span[e][1] - span[e][0] for e in ids], dtype=np.int64)
    X = np.zeros((len(ids), int(lengths.max()), M.shape[1]), np.float32)
    for i, e in enumerate(ids):
        s, t = span[e]
        X[i, : t - s] = M[s:t]
    return X, lengths


def _lstm_net(n_in: int):
    import torch
    from torch import nn
    from torch.nn.utils.rnn import pack_padded_sequence

    class Net(nn.Module):
        """Per-CDM projection -> LSTM (packed, so padding is never read) -> head on [final hidden state, latest CDM]."""

        def __init__(self):
            super().__init__()
            self.proj = nn.Sequential(nn.Linear(n_in, LSTM_HIDDEN), nn.ReLU())
            self.lstm = nn.LSTM(LSTM_HIDDEN, LSTM_HIDDEN, batch_first=True)
            self.head = nn.Sequential(nn.Linear(LSTM_HIDDEN + n_in, 32), nn.ReLU(), nn.Dropout(0.2), nn.Linear(32, 1))

        def forward(self, x, lengths):
            packed = pack_padded_sequence(self.proj(x), lengths, batch_first=True, enforce_sorted=False)
            _, (h, _) = self.lstm(packed)
            last = x[torch.arange(len(x)), lengths - 1]
            return self.head(torch.cat([h[-1], last], dim=1)).squeeze(1)

    return Net()


def _lstm_scores(net, X: np.ndarray, L: np.ndarray) -> np.ndarray:
    import torch

    net.eval()
    with torch.no_grad():
        return torch.sigmoid(net(torch.from_numpy(X), torch.from_numpy(L))).numpy().astype(float)


def _fit_lstm(X, L, y, epochs: int, pos_weight: float, seed: int, monitor=None):
    """Adam + BCE (pos_weight up-weights high-risk events). `monitor` = (X, L, y): validation PR-AUC after each epoch."""
    import torch
    from sklearn.metrics import average_precision_score

    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    net = _lstm_net(X.shape[2])
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=torch.tensor(float(pos_weight)))
    Xt, Lt, yt = torch.from_numpy(X), torch.from_numpy(L), torch.from_numpy(y.astype(np.float32))
    history = []
    for _ in range(epochs):
        net.train()
        perm = rng.permutation(len(X))
        for b in range(0, len(X), LSTM_BATCH):
            idx = torch.from_numpy(perm[b : b + LSTM_BATCH])
            opt.zero_grad()
            loss_fn(net(Xt[idx], Lt[idx]), yt[idx]).backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
        if monitor is not None:
            history.append(float(average_precision_score(monitor[2], _lstm_scores(net, monitor[0], monitor[1]))))
    return net, history


def _crossfit_lstm(X, L, y, epochs: int, pos_weight: float) -> list:
    """5 (net, isotonic) pairs: each net trained on 4/5 of the training events, isotonic fitted on the left-out 1/5."""
    from sklearn.isotonic import IsotonicRegression
    from sklearn.model_selection import StratifiedKFold

    out = []
    for k, (tr_i, va_i) in enumerate(StratifiedKFold(5, shuffle=True, random_state=SEED).split(X, y)):
        net, _ = _fit_lstm(X[tr_i], L[tr_i], y[tr_i], epochs, pos_weight, SEED + k)
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(_lstm_scores(net, X[va_i], L[va_i]), y[va_i])
        out.append((net, iso))
    return out


def _paired_diff_ci(y_high: np.ndarray, a: dict, b: dict, n_boot: int = 1000, seed: int = SEED) -> dict:
    """95% bootstrap CI (resampling events) of a − b for Brier, PR-AUC and false-alert rate."""
    from sklearn.metrics import average_precision_score

    rng = np.random.default_rng(seed)
    n = len(y_high)
    d: dict[str, list[float]] = {"brier": [], "pr_auc": [], "false_alert_rate": []}
    for _ in range(n_boot):
        i = rng.integers(0, n, n)
        y = y_high[i]
        if y.sum() < 3 or y.all():
            continue
        neg = ~y
        d["brier"].append(float(np.mean((a["p"][i] - y) ** 2) - np.mean((b["p"][i] - y) ** 2)))
        d["pr_auc"].append(float(average_precision_score(y, a["rank"][i]) - average_precision_score(y, b["rank"][i])))
        d["false_alert_rate"].append(float(a["high"][i][neg].mean() - b["high"][i][neg].mean()))
    return {k: _ci(v) for k, v in d.items()}


def benchmark_lstm() -> dict:
    """Train the LSTM benchmark (full-CDM and live-input variants), compare with the saved trees and the baseline on
    validation, held-out and official test events, and save the comparison in metrics.json `model_comparison`."""
    import joblib
    import torch
    from sklearn.isotonic import IsotonicRegression

    t0 = time.time()
    torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
    P = prepare()
    trees = {"full": joblib.load(MODEL_DIR / "full.joblib"), "live": joblib.load(MODEL_DIR / "live.joblib")}
    tr_ids, va_ids, ho_ids = list(P["tr_ids"]), list(P["va_ids"]), list(P["ho_ids"])
    d_tr = _cdm_frame(P["tr"])
    d_te = _cdm_frame(P["te"])
    te_ids = list(P["feats_te"].index)
    ys = {"train": P["y_final_all"].loc[tr_ids].to_numpy(float), "validation": P["y_final_all"].loc[va_ids].to_numpy(float),
          "holdout": P["y_final_all"].loc[ho_ids].to_numpy(float), "official_test": P["y_te"]}
    yb = {k: (v >= HIGH_RISK).astype(int) for k, v in ys.items()}

    # Inputs per variant. Full: every numeric CDM column (the trees' "full" inputs, per CDM instead of summarised).
    skip = {"event_id", "mission_id", "c_object_type", "object_type"}
    full_cols = [c for c in d_tr.columns if c not in skip and np.issubdtype(d_tr[c].dtype, np.number)]
    live_cols = [LSTM_LIVE_COLUMNS[n] for n in trees["live"]["names"] if n in LSTM_LIVE_COLUMNS]
    missions = sorted(int(m) for m in d_tr.loc[d_tr["event_id"].isin(tr_ids), "mission_id"].unique())
    fit_rows = d_tr[d_tr["event_id"].isin(tr_ids)]
    variants = {"full": _SeqPrep(fit_rows, full_cols, missions), "live": _SeqPrep(fit_rows, live_cols, None)}

    seqs: dict[str, dict] = {}
    for v, prep in variants.items():
        M_tr, M_te = prep.transform(d_tr), prep.transform(d_te)
        seqs[v] = {"train": _padded(d_tr, M_tr, tr_ids), "validation": _padded(d_tr, M_tr, va_ids),
                   "holdout": _padded(d_tr, M_tr, ho_ids), "official_test": _padded(d_te, M_te, te_ids)}
    print(f"sequences: full {seqs['full']['train'][0].shape[2]} inputs/CDM, live {seqs['live']['train'][0].shape[2]}; "
          f"max length {seqs['full']['train'][0].shape[1]} | {time.time()-t0:.0f}s", flush=True)

    # ---- settings on validation: class weighting x epochs, by validation PR-AUC (rank-based, so calibration-free)
    n_pos = int(yb["train"].sum())
    weights = {"none": 1.0, "balanced": (len(yb["train"]) - n_pos) / max(n_pos, 1)}
    lstm: dict[str, dict] = {}
    for v in variants:
        Xtr, Ltr = seqs[v]["train"]
        mon = (*seqs[v]["validation"], yb["validation"])
        tried = {}
        for wk, pw in weights.items():
            _, hist = _fit_lstm(Xtr, Ltr, yb["train"], LSTM_MAX_EPOCHS, pw, SEED, monitor=mon)
            best = int(np.argmax(hist[4:])) + 5  # at least 5 epochs
            tried[wk] = {"pos_weight": pw, "best_epochs": best, "validation_pr_auc": hist[best - 1], "curve": hist}
            print(f"  lstm {v} weighting {wk}: best val PR-AUC {hist[best-1]:.3f} at epoch {best} | {time.time()-t0:.0f}s", flush=True)
        wk = max(tried, key=lambda k: tried[k]["validation_pr_auc"])
        fams = _crossfit_lstm(Xtr, Ltr, yb["train"], tried[wk]["best_epochs"], tried[wk]["pos_weight"])
        raw = {ds: np.mean([_lstm_scores(n, *seqs[v][ds]) for n, _ in fams], axis=0) for ds in ("validation", "holdout", "official_test")}
        cal = {ds: np.mean([iso.predict(_lstm_scores(n, *seqs[v][ds])) for n, iso in fams], axis=0) for ds in raw}
        # Variant for reference: isotonic fitted on the validation events instead (raw scores averaged over the 5 nets).
        iso_va = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(raw["validation"], yb["validation"])
        lstm[v] = {"p": cal, "p_val_iso": {ds: iso_va.predict(r) for ds, r in raw.items()},
                   "hyper": {"weighting": wk, "pos_weight": tried[wk]["pos_weight"], "epochs": tried[wk]["best_epochs"], "hidden": LSTM_HIDDEN,
                             "batch": LSTM_BATCH, "lr": 1e-3, "weight_decay": 1e-4, "inputs_per_cdm": int(seqs[v]["train"][0].shape[2]),
                             "parameters": int(sum(p.numel() for p in fams[0][0].parameters())),
                             "tried": {k: {kk: vv for kk, vv in t.items() if kk != "curve"} for k, t in tried.items()}}}
        print(f"  lstm {v}: cross-fitted ({wk}, {tried[wk]['best_epochs']} epochs) | {time.time()-t0:.0f}s", flush=True)

    # ---- every model's probabilities + its 95%-recall threshold from validation
    latest = {"validation": P["latest_all"].loc[va_ids].to_numpy(float), "holdout": P["latest_all"].loc[ho_ids].to_numpy(float),
              "official_test": P["latest_te"].to_numpy(float)}
    feats = {"validation": P["feats_all"].loc[va_ids], "holdout": P["feats_all"].loc[ho_ids], "official_test": P["feats_te"]}
    probs: dict[str, dict[str, np.ndarray]] = {"baseline": {}, "trees_full": {}, "trees_live": {}, "lstm_full": {}, "lstm_live": {},
                                               "lstm_full_val_iso": {}, "lstm_live_val_iso": {}}
    for ds in latest:
        probs["baseline"][ds] = 10.0 ** latest[ds]  # ranking only; its Brier uses the hard yes/no (risk >= 1e-6)
        probs["trees_full"][ds] = trees["full"]["clf"].predict_proba(feats[ds][trees["full"]["names"]].to_numpy(float))[:, 1]
        probs["trees_live"][ds] = trees["live"]["clf"].predict_proba(live_matrix(feats[ds], trees["live"]["names"]).to_numpy(float))[:, 1]
        for v in variants:
            probs[f"lstm_{v}"][ds] = lstm[v]["p"][ds]
            probs[f"lstm_{v}_val_iso"][ds] = lstm[v]["p_val_iso"][ds]
    thresholds = {"trees_full": float(trees["full"]["threshold"]), "trees_live": float(trees["live"]["threshold"])}
    for k in probs:
        if k not in thresholds:
            thresholds[k] = operating_threshold(yb["validation"], probs[k]["validation"])[0]

    def pred(k: str, ds: str) -> dict:
        p = probs[k][ds]
        brier_p = (latest[ds] >= HIGH_RISK).astype(float) if k == "baseline" else p
        return {"p": brier_p, "rank": p, "high": p >= thresholds[k]}

    def row(k: str, ds: str) -> dict:
        q = pred(k, ds)
        s = score_set(ys[ds], latest[ds], q["p"], q["high"], q["rank"])
        return {**{m: s[m] for m in ("n", "n_high_risk", "brier", "ece", "pr_auc", "roc_auc", "recall", "false_alert_rate", "precision", "alerts", "tp", "fn", "fp")},
                "threshold": thresholds[k]}

    sets = ("validation", "holdout", "official_test")
    table = {ds: {k: row(k, ds) for k in probs} for ds in sets}
    ci = {ds: {f"lstm_{v}_vs_trees_{v}": _paired_diff_ci(yb[ds].astype(bool), pred(f"lstm_{v}", ds), pred(f"trees_{v}", ds)) for v in variants}
          for ds in ("holdout", "official_test")}

    # ---- which model is live: the LSTM replaces the trees only if it is better on validation Brier AND PR-AUC
    va = table["validation"]
    lstm_wins = {v: va[f"lstm_{v}"]["brier"] < va[f"trees_{v}"]["brier"] and va[f"lstm_{v}"]["pr_auc"] > va[f"trees_{v}"]["pr_auc"] for v in variants}
    live_choice = "lstm" if lstm_wins["live"] else "trees"
    reason = (f"Validation (live inputs): trees Brier {va['trees_live']['brier']:.5f}, PR-AUC {va['trees_live']['pr_auc']:.3f}; "
              f"LSTM Brier {va['lstm_live']['brier']:.5f}, PR-AUC {va['lstm_live']['pr_auc']:.3f}. "
              + ("The LSTM is better on both." if lstm_wins["live"] else "The LSTM is not better on both, so the trees stay live."))
    print(reason, flush=True)

    m = json.loads(METRICS_PATH.read_text(encoding="utf-8")) if METRICS_PATH.exists() else {}
    result = {
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "trees_trained_utc": m.get("generated_utc"),
        "versions": {"torch": torch.__version__},
        "method": {
            "split": "the same events as the trees (60/20/20 by event, seed 42); inputs only CDMs >= 2 days before TCA; target: final risk >= 1e-6",
            "lstm": (f"per-CDM linear+ReLU projection -> 1-layer LSTM ({LSTM_HIDDEN} units, packed variable-length sequences, max 17 CDMs) -> "
                     "MLP head on [final hidden state, latest CDM]; Adam, BCE, up to 40 epochs"),
            "calibration": "as the trees: 5-fold cross-fitting on the training events, isotonic on each left-out fold, 5 calibrated models averaged",
            "selection": "LSTM class weighting and epochs by validation PR-AUC; every alert threshold on validation (>= 95% recall)",
            "baseline": "latest risk; Brier from its hard yes/no (risk >= 1e-6); recall/false alerts at its own 95%-recall threshold on validation; PR-AUC ranks by latest risk",
            "inputs": {"lstm_full": "every numeric CDM column + object type + mission (one-hot), per CDM",
                       "lstm_live": f"per CDM, the live model's inputs: {', '.join(trees['live']['names'])}"},
        },
        "lstm": {v: lstm[v]["hyper"] for v in variants},
        "results": table,
        "diff_ci": ci,
        "lstm_better_on_validation": lstm_wins,
        "live_model": live_choice,
        "live_rule": "the LSTM replaces the live trees only if its live-input version beats them on validation Brier AND PR-AUC",
        "reason": reason,
        "seconds": round(time.time() - t0, 1),
    }
    m["model_comparison"] = result
    METRICS_PATH.write_text(json.dumps(_clean(m), indent=2), encoding="utf-8")
    for ds in sets:
        print(f"\n{ds}:", flush=True)
        for k, r in table[ds].items():
            print(f"  {k:20s} Brier {r['brier']:.5f}  PR-AUC {r['pr_auc']:.3f}  recall {r['recall']:.3f}  false alerts {r['false_alert_rate']:.3f}  (thr {r['threshold']:.3g})", flush=True)
    print(f"saved metrics.json model_comparison ({time.time()-t0:.0f}s)", flush=True)
    return result


# =========================================================================== runtime inference (no pandas)

_models: dict | None = None
_metrics: dict | None = None


def _load():
    global _models, _metrics
    if _models is not None:
        return
    import joblib

    _models = {}
    for name in ("full", "live"):
        p = MODEL_DIR / f"{name}.joblib"
        if p.exists():
            _models[name] = joblib.load(p)
    _metrics = _clean(json.loads(METRICS_PATH.read_text(encoding="utf-8"))) if METRICS_PATH.exists() else None


def available() -> bool:
    _load()
    return bool(_models and "live" in _models)


def model_metrics() -> dict | None:
    _load()
    return _metrics


def live_threshold() -> float | None:
    """The live model's operating threshold on P(high-risk) (chosen on validation for ≥ 95% recall)."""
    _load()
    return float(_models["live"]["threshold"]) if _models and "live" in _models else None


def _live_inputs(c: dict, tte_days: float) -> dict:
    miss_m = c["miss_km"] * 1000.0
    sigma = max(c["sigma_km"], 1e-6)
    log_pc = max(math.log10(c["pc"]), RISK_FLOOR) if c["pc"] > 0 else RISK_FLOOR
    return {
        "miss_distance_m": miss_m,
        "relative_speed_ms": c["vrel_kms"] * 1000.0,
        "time_to_tca_d": tte_days,
        "log10_pc": log_pc,
        "sigma_km": sigma,
        "miss_over_sigma": miss_m / (1000.0 * sigma),
        "object_type": OBJECT_CODES.get(c.get("object_type", "UNKNOWN"), 3),
        "radial_sep_m": abs(c["radial_km"]) * 1000.0 if c.get("radial_km") is not None else float("nan"),
    }


def score_conjunctions(results: list[dict], now: datetime) -> None:
    """Add the live model's estimate to each /screen result (in place).

    ai_p_high is the calibrated probability that the FINAL collision risk will be >= 1e-6, as learned from ESA's
    CDM data; ai_log10_risk is the model's estimate of the final log10 risk. These are model estimates, not
    measurements. The model was trained on conjunctions 2-7 days before TCA; ai_in_domain is False outside that range.

    ai_contributions explains ai_p_high per input group (LIVE_GROUPS): the probability now minus the probability with
    that group set to its training median ("typical ESA event"). Positive = this input raises the AI probability.
    shap.TreeExplainer does not support the isotonic-calibrated ensemble (CalibratedClassifierCV), hence this method.
    """
    _load()
    if not results or not _models or "live" not in _models:
        return
    m = _models["live"]
    names = m["names"]
    n = len(results)
    X = np.empty((n, len(names)))
    latest = np.empty(n)
    tte = np.empty(n)
    for i, c in enumerate(results):
        tca = datetime.fromisoformat(c["tca_utc"].replace("Z", "+00:00"))
        tte[i] = (tca - now).total_seconds() / 86400.0
        row = _live_inputs(c, tte[i])
        latest[i] = row["log10_pc"]
        X[i] = [row[k] for k in names]
    pred = predict_family(m, X, latest)

    groups = {g: [names.index(f) for f in fs if f in names] for g, fs in LIVE_GROUPS.items()}
    groups = {g: idx for g, idx in groups.items() if idx}
    contrib = None
    if m.get("medians") is not None:
        blocks = [X]
        for idx in groups.values():
            Xg = X.copy()
            Xg[:, idx] = np.asarray(m["medians"])[idx]
            blocks.append(Xg)
        P = m["clf"].predict_proba(np.vstack(blocks))[:, 1].reshape(len(blocks), n)
        contrib = {g: P[0] - P[k + 1] for k, g in enumerate(groups)}

    for i, c in enumerate(results):
        c["ai_p_high"] = float(pred["p"][i])
        c["ai_log10_risk"] = float(pred["risk"][i])
        c["ai_in_domain"] = bool(MIN_TCA_DAYS <= tte[i] <= MAX_TCA_DAYS)
        c["ai_threshold"] = float(m["threshold"])
        if contrib is not None:
            c["ai_contributions"] = {g: round(float(v[i]), 5) for g, v in contrib.items()}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "train":
        train()
    elif cmd == "throughput":
        measure_throughput()
    elif cmd == "decision-kpis":
        measure_decision_kpis()
    elif cmd == "lstm":
        benchmark_lstm()
    else:
        print("usage: python ml.py train | throughput | decision-kpis | lstm")
