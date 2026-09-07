"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { updateProfileAction } from "@/app/actions/profile-actions";
import { Feedback } from "@/components/feedback";
import {
  AGENT_AUTHORITIES,
  DIETS,
  type AgentAuthority,
  type Diet,
} from "@/domain/vocabulary";
import { emptyToNull, optionalNumber } from "@/lib/form-values";
import { useActionRunner } from "@/lib/use-action-runner";

/**
 * The enforced half of the profile, grouped the way the spec groups it:
 * dietary, kitchen, organization, preferences. Every field here either blocks a
 * write, warns on one, or is read by an agent, which is why none of it is free
 * text except the diet notes.
 *
 * `diet` and `agentAuthority` carry the vocabulary unions rather than `string`,
 * so a value the enum does not have is a compile error here instead of a
 * refusal from the service.
 */

export interface ProfileFormValues {
  readonly diet: Diet;
  readonly dietNotes: string | null;
  readonly skillLevel: number;
  readonly defaultServings: number;
  readonly defaultTimeBudgetMin: number | null;
  readonly timeBudgetToleranceMin: number;
  readonly varietyPreference: number;
  readonly shoppingDay: number | null;
  readonly weeklyBudgetAmount: number | null;
  readonly weeklyBudgetCurrency: string | null;
  readonly agentAuthority: AgentAuthority;
}

export function ProfileForm({ profile }: { profile: ProfileFormValues }) {
  const t = useTranslations("profile");
  const common = useTranslations("common");
  const days = useTranslations("week.days");
  const runner = useActionRunner();

  /*
   * What the user has typed, keyed by the props it was typed against. The
   * previous version seeded `useState` from `profile` and never looked at the
   * prop again, so a profile changed elsewhere (an agent over MCP, or this same
   * form in another tab) never appeared. Comparing identities during render
   * means a save that refreshes the page drops the draft and shows what was
   * actually stored, with no effect and no stale frame.
   */
  const [draft, setDraft] = useState<{
    readonly of: ProfileFormValues;
    readonly values: ProfileFormValues;
  } | null>(null);
  const values =
    draft !== null && draft.of === profile ? draft.values : profile;

  const [saved, setSaved] = useState(false);

  function set<K extends keyof ProfileFormValues>(
    key: K,
    value: ProfileFormValues[K],
  ): void {
    setDraft({ of: profile, values: { ...values, [key]: value } });
    setSaved(false);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void runner.run(
      () =>
        updateProfileAction({
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
        }),
      { onSuccess: () => setSaved(true) },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      <section className="flex flex-col gap-4">
        <h2 className="eyebrow eyebrow-rule">{t("groups.dietary")}</h2>
        <label className="label max-w-sm">
          <span>{t("diet")}</span>
          <select
            value={values.diet}
            onChange={(event) => set("diet", event.target.value as Diet)}
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
            onChange={(event) =>
              set("agentAuthority", event.target.value as AgentAuthority)
            }
            className="field"
          >
            {/*
              Labelled by key, not by a binary ternary. The previous version
              read `authority === "proposal" ? … : …`, so a third authority
              added to the vocabulary would have been labelled "direct".
            */}
            {AGENT_AUTHORITIES.map((authority) => (
              <option key={authority} value={authority}>
                {t(`agentAuthorities.${authority}`)}
              </option>
            ))}
          </select>
          <span className="hint">{t("agentAuthorityHelp")}</span>
        </label>
      </section>

      <div className="flex items-center gap-3 border-t border-rule pt-5">
        <button
          type="submit"
          disabled={runner.pending}
          className="btn btn-primary"
        >
          {runner.pending ? common("saving") : common("save")}
        </button>
        {saved && runner.feedback === null ? (
          <span className="chip chip-ok" aria-live="polite">
            {t("saved")}
          </span>
        ) : null}
      </div>
    </form>
  );
}
