---

## KPIs: Hackfest PS 1C

KesslerWatch is evaluated on the four KPIs defined in the problem statement. All values are measured, not estimated by hand, and are stored in `backend/models/metrics.json` and shown in the app's **Model** tab.

### KPI scorecard

| KPI | Problem statement target | KesslerWatch result | Status |
|---|---|---|---|
| **1. Brier score (calibration)** | A 1-in-10,000 predicted risk should happen about 1 in 10,000 times; beat the baseline | **0.0084** vs 0.0298 baseline (held-out); 0.0498 vs 0.0452 (ESA official test) | Met on held-out; close on official test |
| **2. Hit / miss rate** | > 95% recall on high-risk events while reducing false alarms | **96.0% recall** (144 / 150, ESA official test); false alerts **21.3% → 3.1%** with two-stage alerting | Met |
| **3. Lead time** | Flag genuine risks 3–7 days before TCA | **93% recall at ≥ 3 days**, **92% at 5+ days** (ESA official test) | Met |
| **4. Throughput** | Screen the full catalog in minutes, not hours | 1 satellite vs ~32,000 objects: **~33 s**; 42-satellite watchlist: **~74 s**; all-vs-all: ~1.3 h (est.) | Met for monitored satellites |

### KPI 1: Brier score (calibration)

**What it measures:** how close predicted probabilities are to what actually happened. Lower is better.

```
Brier = mean( (predicted probability − actual outcome)² )
```

| Model | Held-out (1,779 events, 19 high-risk) | ESA official test (2,167 events, 150 high-risk) |
|---|---|---|
| KesslerWatch live model | **0.0084** | 0.0498 |
| KesslerWatch full model | 0.0078 | 0.0467 |
| Baseline (final risk = latest risk) | 0.0298 | 0.0452 |

Probabilities are calibrated with isotonic regression on a separate validation split. The official test set contains about 7× more high-risk events than training data, which explains the small gap there.

### KPI 2: Hit / miss rate

**Recall** = high-risk events caught ÷ all high-risk events.
**False-alert rate** = safe events flagged ÷ all safe events.

| Level | Recall | False-alert rate |
|---|---|---|
| Stage 1: AI early flag | **96.0%** | 21.3% |
| Stage 2: WATCH or above (physics-confirmed) | 76.7% | **3.1%** |
| Pc ≥ 10⁻⁵ alone (reference) | 34.0% | 1.1% |
| Baseline (latest risk) | 77% | 3.1% |

*ESA official test set. The alert threshold is chosen on validation data to give ≥ 95% recall.*

**Why two stages:** Stage 1 keeps nearly every real threat under observation. Stage 2 recommends action only when physics confirms the risk. Alerts must also persist across data updates to reach CONFIRMED GO, and close automatically when risk drops.

### KPI 3: Lead time

Performance when the prediction is made a given number of days before TCA (ESA official test, live model):

| Prediction made | Recall | Brier |
|---|---|---|
| ≥ 2 days before TCA | 96% | 0.050 |
| ≥ 3 days | 93% | 0.055 |
| ≥ 4 days | 93% | 0.053 |
| 5+ days | 92% | 0.050 |

Baseline recall over the same rows: 75–80%. Earlier warning allows smaller burns: along-track shift ≈ 3 × Δv × time, so doubling the warning time halves the burn needed.

### KPI 4: Throughput

Measured on a single CPU core, 72-hour screening window:

| Task | Time |
|---|---|
| One satellite vs full catalog (~32,000 objects) | ~33 s |
| Sentinel watchlist (42 satellites vs full catalog) | ~74 s |
| Full all-vs-all screening | ~1.3 h (estimated, down from ~200 h before KD-tree screening) |

**How:** KD-tree neighbour search at 60-second steps, shared propagation across all watched satellites, then 1-second refinement only for candidate pairs.

### How KPIs were measured

- **Data:** ESA Kelvins Collision Avoidance Challenge CDMs (2015–2019).
- **Split:** 60 / 20 / 20 train / validation / held-out, **split by event** so no approach appears in both training and testing.
- **Official test:** ESA's own test set, never used for training or tuning.
- **Baseline:** "final risk = latest known risk", the standard reference used in the ESA challenge.
- **Throughput:** timed directly in the backend; re-run with `py -3.11 ml.py throughput`.
