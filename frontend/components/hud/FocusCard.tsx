"use client";

import { X } from "lucide-react";
import { objectType, type CatalogEntry, type Conjunction, type OfficialType, type ReentryItem } from "@/lib/api";
import { Glass, TypeBadge } from "./Glass";
import { AiRisk, fmtPc } from "./RightPanel";

const typeOf = (t: OfficialType) => objectType({ object_type: t } as CatalogEntry);

function Fig({ value, label, tone = "" }: { value: string; label: string; tone?: string }) {
  return (
    <div>
      <div className={`font-mono text-[17px] leading-tight ${tone}`}>{value}</div>
      <div className="text-[14px] text-muted">{label}</div>
    </div>
  );
}

/** Summary card for focus mode with the "Clear focus" action. Sits under the top nav. */
export function FocusCard({
  conjunction,
  primary,
  reentry,
  onClear,
}: {
  conjunction: Conjunction | null;
  primary: CatalogEntry | null;
  reentry: ReentryItem | null;
  onClear: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[118px] z-20 flex justify-center px-4">
      <Glass className="fade-in pointer-events-auto w-full max-w-[600px] px-5 py-3.5" style={{ borderRadius: 18 }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow">{conjunction ? "Close approach · focus" : "Re-entry watch · focus"}</div>
            {conjunction && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-ice shadow-[0_0_8px_var(--color-ice)]" />
                  <span className="font-serif text-[19px] font-semibold">{primary?.name ?? conjunction.primary_norad}</span>
                </span>
                <span className="text-muted">↔</span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose shadow-[0_0_8px_var(--color-rose)]" />
                  <span className="font-serif text-[19px] font-semibold">{conjunction.name}</span>
                </span>
                <TypeBadge type={typeOf(conjunction.object_type)} />
              </div>
            )}
            {reentry && (
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-amber shadow-[0_0_8px_var(--color-amber)]" />
                <span className="font-serif text-[19px] font-semibold">{reentry.name}</span>
                <TypeBadge type={typeOf(reentry.object_type)} />
              </div>
            )}
          </div>
          <button type="button" onClick={onClear} className="quiet-btn inline-flex shrink-0 items-center gap-1.5">
            <X className="h-3.5 w-3.5" strokeWidth={1.75} /> Clear focus
          </button>
        </div>

        {conjunction && (
          <div className="mt-2.5 flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className={`font-mono text-[28px] leading-none ${conjunction.alert ? "text-rose" : conjunction.level === "watch" ? "text-gold" : ""}`}>
                {fmtPc(conjunction.pc)}
              </div>
              <div className="mt-1 text-[14px] text-muted">Physics Pc</div>
            </div>
            <AiRisk c={conjunction} />
            <Fig value={`${conjunction.miss_km.toFixed(2)} km`} label="Miss distance" />
            <Fig value={`${conjunction.vrel_kms.toFixed(2)} km/s`} label="Relative velocity" />
            <Fig value={`${conjunction.sigma_km.toFixed(2)} km`} label="σ (assumed)" />
            <Fig value={conjunction.tca_utc.slice(5, 19).replace("T", " ")} label="TCA, UTC (clock paused here)" />
            {conjunction.ai_in_domain === false && (
              <p className="basis-full text-[14px] text-muted">AI risk is outside its 2–7 day training range for this approach.</p>
            )}
          </div>
        )}

        {reentry && (
          <div className="mt-2.5 flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className={`font-mono text-[28px] leading-none ${reentry.risk === "high" ? "text-rose" : "text-amber"}`}>
                {reentry.overdue ? "Imminent (est.)" : `est. ${reentry.est_days < 1 ? "< 1" : reentry.est_days.toFixed(0)} d`}
              </div>
              <div className="mt-1 text-[14px] text-muted">{reentry.overdue ? "Estimated date already passed; may have re-entered" : "To re-entry"}</div>
            </div>
            <Fig value={`${Math.round(reentry.perigee_km)} × ${Math.round(reentry.apogee_km)} km`} label="Perigee × apogee" />
            <Fig value={`${reentry.tle_age_days.toFixed(1)} d`} label="TLE age" />
            <p className="basis-full text-[14px] text-muted">Heuristic from the TLE mean-motion derivative (est.), usually an overestimate.</p>
          </div>
        )}
      </Glass>
    </div>
  );
}
