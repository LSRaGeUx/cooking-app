"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  createAllergenAction,
  createEquipmentAction,
  createExclusionAction,
  deleteAllergenAction,
  deleteEquipmentAction,
  deleteExclusionAction,
} from "@/app/actions/profile-actions";
import { Feedback } from "@/components/feedback";
import { slugify } from "@/domain/slug";
import {
  ALLERGEN_SEVERITIES,
  EQUIPMENT_KEYS,
  type AllergenSeverityValue,
} from "@/domain/vocabulary";
import { useActionRunner } from "@/lib/use-action-runner";

/**
 * Allergens, refused ingredients, and equipment.
 *
 * The allergen editor is the one screen in the app where a mistake is a health
 * event, so it asks for the trigger words explicitly rather than inferring
 * them: the matcher never guesses beyond what is listed here, and the user has
 * to be able to see exactly what will fire.
 */

export interface AllergenRow {
  readonly id: string;
  readonly name: string;
  readonly severity: AllergenSeverityValue;
  /** The words that fire this allergen. Shown, because nothing is guessed. */
  readonly matches: readonly string[];
}

/**
 * `matches` used to be an optional field here as well and was never read: an
 * exclusion's trigger words are sent when it is created and not displayed
 * back.
 */
export interface NamedRow {
  readonly id: string;
  readonly name: string;
}

export interface EquipmentRow {
  readonly id: string;
  readonly key: string;
  readonly label: string | null;
}

export function ConstraintLists({
  allergens,
  exclusions,
  equipment,
}: {
  allergens: readonly AllergenRow[];
  exclusions: readonly NamedRow[];
  equipment: readonly EquipmentRow[];
}) {
  const t = useTranslations("profile");
  const common = useTranslations("common");
  const runner = useActionRunner();

  const [allergenName, setAllergenName] = useState("");
  const [allergenSeverity, setAllergenSeverity] =
    useState<AllergenSeverityValue>("strict");
  const [allergenMatches, setAllergenMatches] = useState("");
  const [exclusionName, setExclusionName] = useState("");
  const [exclusionMatches, setExclusionMatches] = useState("");
  const [customEquipment, setCustomEquipment] = useState("");

  const declared = new Set(equipment.map((row) => row.key));
  // Evaluated once. The same filter used to run twice, once to decide whether
  // to render the section and once to render it.
  const custom = useMemo(
    () =>
      equipment.filter(
        (row) => !(EQUIPMENT_KEYS as readonly string[]).includes(row.key),
      ),
    [equipment],
  );

  return (
    <div className="flex flex-col gap-8">
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="eyebrow eyebrow-rule">{t("allergens")}</h2>
          <p className="hint">{t("allergensHelp")}</p>
        </div>

        {allergens.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {allergens.map((allergen) => (
              <li
                key={allergen.id}
                className={`slip flex flex-wrap items-baseline gap-2.5 border-l-[3px] px-3 py-2.5 text-sm ${
                  allergen.severity === "strict"
                    ? "border-l-danger"
                    : "border-l-amber-ink"
                }`}
              >
                <span className="display text-base">{allergen.name}</span>
                <span
                  className={`chip ${
                    allergen.severity === "strict" ? "chip-danger" : "chip-warn"
                  }`}
                >
                  {severityLabel(t, allergen.severity)}
                </span>
                {allergen.matches.length > 0 ? (
                  <span className="micro">{allergen.matches.join(", ")}</span>
                ) : null}
                <button
                  type="button"
                  disabled={runner.pending}
                  onClick={() =>
                    void runner.run(() => deleteAllergenAction(allergen.id))
                  }
                  className="btn btn-ghost btn-sm ml-auto"
                >
                  {common("delete")}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className="label min-w-[10rem] flex-1">
            <span>{t("allergenName")}</span>
            <input
              value={allergenName}
              onChange={(event) => setAllergenName(event.target.value)}
              className="field"
            />
          </label>
          <label className="label">
            <span>{t("allergenSeverity")}</span>
            <select
              value={allergenSeverity}
              onChange={(event) =>
                setAllergenSeverity(event.target.value as AllergenSeverityValue)
              }
              className="field"
            >
              {ALLERGEN_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severityLabel(t, severity)}
                </option>
              ))}
            </select>
          </label>
          <label className="label min-w-[12rem] flex-1">
            <span>{t("matches")}</span>
            <input
              value={allergenMatches}
              onChange={(event) => setAllergenMatches(event.target.value)}
              className="field"
            />
            <span className="hint">{t("matchesHelp")}</span>
          </label>
          <button
            type="button"
            disabled={runner.pending || allergenName.trim().length === 0}
            onClick={() =>
              void runner
                .run(() =>
                  createAllergenAction({
                    name: allergenName.trim(),
                    severity: allergenSeverity,
                    matches: splitList(allergenMatches),
                  }),
                )
                .then((result) => {
                  if (!result?.ok) return;
                  setAllergenName("");
                  setAllergenMatches("");
                })
            }
            className="btn btn-quiet"
          >
            {common("add")}
          </button>
        </div>

        <p className="banner banner-danger">{t("strictWarning")}</p>
      </section>

      <section className="flex flex-col gap-3 pt-2">
        <div className="flex flex-col gap-1">
          <h2 className="eyebrow eyebrow-rule">{t("exclusions")}</h2>
          <p className="hint">{t("exclusionsHelp")}</p>
        </div>

        {exclusions.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {exclusions.map((exclusion) => (
              <li
                key={exclusion.id}
                className="slip flex items-center gap-2 py-1 pl-2.5 pr-1 text-sm"
              >
                <span>{exclusion.name}</span>
                <button
                  type="button"
                  disabled={runner.pending}
                  aria-label={common("delete")}
                  onClick={() =>
                    void runner.run(() => deleteExclusionAction(exclusion.id))
                  }
                  className="px-1.5 text-faint transition-colors hover:text-danger-ink disabled:opacity-30"
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className="label min-w-[10rem] flex-1">
            <span>{t("exclusions")}</span>
            <input
              value={exclusionName}
              onChange={(event) => setExclusionName(event.target.value)}
              className="field"
            />
          </label>
          <label className="label min-w-[12rem] flex-1">
            <span>{t("matches")}</span>
            <input
              value={exclusionMatches}
              onChange={(event) => setExclusionMatches(event.target.value)}
              className="field"
            />
          </label>
          <button
            type="button"
            disabled={runner.pending || exclusionName.trim().length === 0}
            onClick={() =>
              void runner
                .run(() =>
                  createExclusionAction({
                    name: exclusionName.trim(),
                    matches: splitList(exclusionMatches),
                  }),
                )
                .then((result) => {
                  if (!result?.ok) return;
                  setExclusionName("");
                  setExclusionMatches("");
                })
            }
            className="btn btn-quiet"
          >
            {common("add")}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3 pt-2">
        <div className="flex flex-col gap-1">
          {/*
            `profile.equipment` is now the object holding one name per key, so
            the section heading has its own key. The domain used to ship a
            French label beside each key and this screen rendered it as it
            stood, which is how the English interface showed French.
          */}
          <h2 className="eyebrow eyebrow-rule">{t("equipmentTitle")}</h2>
          <p className="hint">{t("equipmentHelp")}</p>
        </div>

        <ul className="flex flex-wrap gap-2">
          {EQUIPMENT_KEYS.map((key) => {
            const owned = equipment.find((row) => row.key === key);
            // The label is UI copy and comes from the catalogues, keyed by the
            // key the domain owns.
            const label = t(`equipment.${key}`);
            return (
              <li key={key}>
                <button
                  type="button"
                  disabled={runner.pending}
                  aria-pressed={declared.has(key)}
                  onClick={() => {
                    // Two calls rather than a ternary inside one: the two
                    // actions return different shapes and `run` is generic in
                    // that shape.
                    if (owned) {
                      void runner.run(() => deleteEquipmentAction(owned.id));
                      return;
                    }
                    void runner.run(() =>
                      createEquipmentAction({ key, label }),
                    );
                  }}
                  className={`btn btn-sm ${
                    declared.has(key)
                      ? "border-olive-line bg-olive-soft text-olive-ink"
                      : "btn-quiet"
                  }`}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>

        {custom.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {custom.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 rounded-[2px] border border-olive-line bg-olive-soft px-2 py-1 text-sm text-olive-ink"
              >
                <span>{row.label ?? row.key}</span>
                <button
                  type="button"
                  disabled={runner.pending}
                  aria-label={common("delete")}
                  onClick={() =>
                    void runner.run(() => deleteEquipmentAction(row.id))
                  }
                  className="px-1.5 text-faint transition-colors hover:text-danger-ink disabled:opacity-30"
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className="label min-w-[12rem] flex-1">
            <span>{t("equipmentOther")}</span>
            <input
              value={customEquipment}
              onChange={(event) => setCustomEquipment(event.target.value)}
              className="field"
            />
          </label>
          <button
            type="button"
            disabled={runner.pending || customEquipment.trim().length === 0}
            onClick={() => {
              const label = customEquipment.trim();
              void runner
                .run(() =>
                  // The domain's `slugify`, shared with the slot editor. Both
                  // components used to carry a copy of it, so the same label
                  // could produce two different keys depending on which screen
                  // typed it. The fallback is what a label of pure punctuation
                  // becomes, because the schema refuses an empty key.
                  createEquipmentAction({
                    key: slugify(label, "equipement"),
                    label,
                  }),
                )
                .then((result) => {
                  if (result?.ok) setCustomEquipment("");
                });
            }}
            className="btn btn-quiet"
          >
            {common("add")}
          </button>
        </div>
      </section>
    </div>
  );
}

/** The two severities, worded from the catalogues rather than by a ternary. */
function severityLabel(
  t: ReturnType<typeof useTranslations>,
  severity: AllergenSeverityValue,
): string {
  return severity === "strict" ? t("severityStrict") : t("severityAvoid");
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
