"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { updateProfileAction } from "@/app/actions/profile-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import { AGENT_AUTHORITIES, DIETS } from "@/domain/vocabulary";

/**
 * The enforced half of the profile, grouped the way the spec groups it:
 * dietary, kitchen, organization, preferences. Every field here either blocks a
 * write, warns on one, or is read by an agent, which is why none of it is free
 * text except the diet notes.
 */

export interface ProfileFormValues {
  readonly diet: string;
  readonly dietNotes: string | null;
  readonly skillLevel: number;
  readonly defaultServings: number;
  readonly defaultTimeBudgetMin: number | null;
  readonly timeBudgetToleranceMin: number;
  readonly varietyPreference: number;
  readonly shoppingDay: number | null;
  readonly weeklyBudgetAmount: number | null;
  readonly weeklyBudgetCurrency: string | null;
  readonly agentAuthority: string;
}

export function ProfileForm({ profile }: { profile: ProfileFormValues }) {
  const t = useTranslations("profile");
  const common = useTranslations("common");
  const days = useTranslations("week.days");
  const router = useRouter();

  const [values, setValues] = useState<ProfileFormValues>(profile);
  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof ProfileFormValues>(
    key: K,
    value: ProfileFormValues[K],
  ): void {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setFeedback({});

    const result = await updateProfileAction({
      diet: values.diet,
      dietNotes: emptyToNull(values.dietNotes),
      skillLevel: values.skillLevel,
      defaultServings: values.defaultServings,
      defaultTimeBudgetMin: values.defaultTimeBudgetMin,
      timeBudgetToleranceMin: values.timeBudgetToleranceMin,
      varietyPreference: values.varietyPreference,
      shoppingDay: values.shoppingDay,
      weeklyBudgetAmount: values.weeklyBudgetAmount,
      weeklyBudgetCurrency: emptyToNull(values.weeklyBudgetCurrency),
      agentAuthority: values.agentAuthority,
    });

    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: {
          code: result.code,
          message: result.message,
          details: result.details,
        },
      });
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <Feedback {...feedback} />

      <section className="flex flex-col gap-4">
        <h2 className="eyebrow eyebrow-rule">{t("groups.dietary")}</h2>
        <label className="label max-w-sm">
          <span>{t("diet")}</span>
          <select
            value={values.diet}
            onChange={(event) => set("diet", event.target.value)}
            className="field"
          >
            {DIETS.map((diet) => (
              <option key={diet} value={diet}>
                {t(`diets.${diet}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="label max-w-2xl">
          <span>{t("dietNotes")}</span>
          <textarea
            rows={2}
            value={values.dietNotes ?? ""}
            onChange={(event) => set("dietNotes", event.target.value)}
            className="field"
          />
          <span className="hint">{t("dietNotesHelp")}</span>
        </label>
      </section>

      <section className="flex flex-col gap-4 pt-2">
        <h2 className="eyebrow eyebrow-rule">{t("groups.kitchen")}</h2>
        <label className="label max-w-xs">
          <span>{t("skillLevel")}</span>
          <input
            type="range"
            min={1}
            max={5}
            value={values.skillLevel}
            onChange={(event) => set("skillLevel", Number(event.target.value))}
          />
          <span className="hint">
            <span className="numeral pr-1 text-lg text-ember-ink">
              {values.skillLevel}
            </span>
            / 5 · {t("skillLevelHelp")}
          </span>
        </label>
      </section>

      <section className="flex flex-col gap-4 pt-2">
        <h2 className="eyebrow eyebrow-rule">{t("groups.organization")}</h2>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
          <label className="label">
            <span>{t("defaultServings")}</span>
            <input
              type="number"
              min={1}
              max={50}
              value={values.defaultServings}
              onChange={(event) =>
                set("defaultServings", Number(event.target.value))
              }
              className="field"
            />
          </label>
          <label className="label">
            <span>{t("defaultTimeBudget")}</span>
            <input
              type="number"
              min={0}
              max={600}
              value={values.defaultTimeBudgetMin ?? ""}
              onChange={(event) =>
                set("defaultTimeBudgetMin", optionalNumber(event.target.value))
              }
              className="field"
            />
          </label>
          <label className="label">
            <span>{t("timeBudgetTolerance")}</span>
            <input
              type="number"
              min={0}
              max={120}
              value={values.timeBudgetToleranceMin}
              onChange={(event) =>
                set("timeBudgetToleranceMin", Number(event.target.value))
              }
              className="field"
            />
          </label>
        </div>
        <p className="hint">
          {t("defaultTimeBudgetHelp")} {t("timeBudgetToleranceHelp")}
        </p>

        {/*
          The shopping day is what a grocery list covers, so it sits with the
          other organisational defaults rather than on the shopping screen.
        */}
        <label className="label max-w-xs">
          <span>{t("shoppingDay")}</span>
          <select
            value={values.shoppingDay ?? ""}
            onChange={(event) =>
              set(
                "shoppingDay",
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
            className="field"
          >
            <option value="">{t("shoppingDayNone")}</option>
            {[1, 2, 3, 4, 5, 6, 7].map((day) => (
              <option key={day} value={day}>
                {days(String(day))}
              </option>
            ))}
          </select>
          <span className="hint">{t("shoppingDayHelp")}</span>
        </label>

      </section>

      <section className="flex flex-col gap-4 pt-2">
        <h2 className="eyebrow eyebrow-rule">{t("groups.preferences")}</h2>

        <label className="label max-w-xs">
          <span>{t("varietyPreference")}</span>
          <input
            type="range"
            min={1}
            max={5}
            value={values.varietyPreference}
            onChange={(event) =>
              set("varietyPreference", Number(event.target.value))
            }
          />
          <span className="hint">
            <span className="numeral pr-1 text-lg text-ember-ink">
              {values.varietyPreference}
            </span>
            / 5 · {t("varietyPreferenceHelp")}
          </span>
        </label>

        <div className="grid max-w-md gap-3 sm:grid-cols-2">
          <label className="label">
            <span>{t("weeklyBudget")}</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={values.weeklyBudgetAmount ?? ""}
              onChange={(event) =>
                set("weeklyBudgetAmount", optionalNumber(event.target.value))
              }
              className="field"
            />
          </label>
          <label className="label">
            <span>{t("weeklyBudgetCurrency")}</span>
            <input
              maxLength={3}
              value={values.weeklyBudgetCurrency ?? ""}
              onChange={(event) =>
                set("weeklyBudgetCurrency", event.target.value.toUpperCase())
              }
              className="field"
            />
          </label>
        </div>
        <p className="hint">{t("weeklyBudgetHelp")}</p>

        <label className="label max-w-sm">
          <span>{t("agentAuthority")}</span>
          <select
            value={values.agentAuthority}
            onChange={(event) => set("agentAuthority", event.target.value)}
            className="field"
          >
            {AGENT_AUTHORITIES.map((authority) => (
              <option key={authority} value={authority}>
                {authority === "proposal"
                  ? t("agentAuthorityProposal")
                  : t("agentAuthorityDirect")}
              </option>
            ))}
          </select>
          <span className="hint">{t("agentAuthorityHelp")}</span>
        </label>
      </section>

      <div className="flex items-center gap-3 border-t border-rule pt-5">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? common("saving") : common("save")}
        </button>
        {saved ? (
          <span className="chip chip-ok" aria-live="polite">
            {t("saved")}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
