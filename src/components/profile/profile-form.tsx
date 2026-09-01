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
  readonly weeklyBudgetAmount: number | null;
  readonly weeklyBudgetCurrency: string | null;
  readonly agentAuthority: string;
}

export function ProfileForm({ profile }: { profile: ProfileFormValues }) {
  const t = useTranslations("profile");
  const common = useTranslations("common");
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
      weeklyBudgetAmount: values.weeklyBudgetAmount,
      weeklyBudgetCurrency: emptyToNull(values.weeklyBudgetCurrency),
      agentAuthority: values.agentAuthority,
    });

    setPending(false);
    if (!result.ok) {
      setFeedback({ error: { code: result.code, message: result.message } });
      return;
    }
    setSaved(true);
    router.refresh();
  }

  const field =
    "rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <Feedback {...feedback} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("groups.dietary")}
        </h2>
        <label className="flex max-w-sm flex-col gap-1 text-sm">
          <span className="font-medium">{t("diet")}</span>
          <select
            value={values.diet}
            onChange={(event) => set("diet", event.target.value)}
            className={field}
          >
            {DIETS.map((diet) => (
              <option key={diet} value={diet}>
                {t(`diets.${diet}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex max-w-2xl flex-col gap-1 text-sm">
          <span className="font-medium">{t("dietNotes")}</span>
          <textarea
            rows={2}
            value={values.dietNotes ?? ""}
            onChange={(event) => set("dietNotes", event.target.value)}
            className={field}
          />
          <span className="text-xs opacity-70">{t("dietNotesHelp")}</span>
        </label>
      </section>

      <section className="flex flex-col gap-3 border-t border-black/10 pt-4 dark:border-white/15">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("groups.kitchen")}
        </h2>
        <label className="flex max-w-xs flex-col gap-1 text-sm">
          <span className="font-medium">{t("skillLevel")}</span>
          <input
            type="range"
            min={1}
            max={5}
            value={values.skillLevel}
            onChange={(event) => set("skillLevel", Number(event.target.value))}
          />
          <span className="text-xs opacity-70">
            {values.skillLevel} / 5 · {t("skillLevelHelp")}
          </span>
        </label>
      </section>

      <section className="flex flex-col gap-3 border-t border-black/10 pt-4 dark:border-white/15">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("groups.organization")}
        </h2>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("defaultServings")}</span>
            <input
              type="number"
              min={1}
              max={50}
              value={values.defaultServings}
              onChange={(event) =>
                set("defaultServings", Number(event.target.value))
              }
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("defaultTimeBudget")}</span>
            <input
              type="number"
              min={0}
              max={600}
              value={values.defaultTimeBudgetMin ?? ""}
              onChange={(event) =>
                set("defaultTimeBudgetMin", optionalNumber(event.target.value))
              }
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("timeBudgetTolerance")}</span>
            <input
              type="number"
              min={0}
              max={120}
              value={values.timeBudgetToleranceMin}
              onChange={(event) =>
                set("timeBudgetToleranceMin", Number(event.target.value))
              }
              className={field}
            />
          </label>
        </div>
        <p className="max-w-2xl text-xs opacity-70">
          {t("defaultTimeBudgetHelp")} {t("timeBudgetToleranceHelp")}
        </p>
      </section>

      <section className="flex flex-col gap-3 border-t border-black/10 pt-4 dark:border-white/15">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("groups.preferences")}
        </h2>

        <label className="flex max-w-xs flex-col gap-1 text-sm">
          <span className="font-medium">{t("varietyPreference")}</span>
          <input
            type="range"
            min={1}
            max={5}
            value={values.varietyPreference}
            onChange={(event) =>
              set("varietyPreference", Number(event.target.value))
            }
          />
          <span className="text-xs opacity-70">
            {values.varietyPreference} / 5 · {t("varietyPreferenceHelp")}
          </span>
        </label>

        <div className="grid max-w-md gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("weeklyBudget")}</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={values.weeklyBudgetAmount ?? ""}
              onChange={(event) =>
                set("weeklyBudgetAmount", optionalNumber(event.target.value))
              }
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("weeklyBudgetCurrency")}</span>
            <input
              maxLength={3}
              value={values.weeklyBudgetCurrency ?? ""}
              onChange={(event) =>
                set("weeklyBudgetCurrency", event.target.value.toUpperCase())
              }
              className={field}
            />
          </label>
        </div>
        <p className="text-xs opacity-70">{t("weeklyBudgetHelp")}</p>

        <label className="flex max-w-sm flex-col gap-1 text-sm">
          <span className="font-medium">{t("agentAuthority")}</span>
          <select
            value={values.agentAuthority}
            onChange={(event) => set("agentAuthority", event.target.value)}
            className={field}
          >
            {AGENT_AUTHORITIES.map((authority) => (
              <option key={authority} value={authority}>
                {authority === "proposal"
                  ? t("agentAuthorityProposal")
                  : t("agentAuthorityDirect")}
              </option>
            ))}
          </select>
          <span className="text-xs opacity-70">{t("agentAuthorityHelp")}</span>
        </label>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {pending ? common("saving") : common("save")}
        </button>
        {saved ? (
          <span className="text-sm opacity-70" aria-live="polite">
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
