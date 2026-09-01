"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createAllergenAction,
  createEquipmentAction,
  createExclusionAction,
  deleteAllergenAction,
  deleteEquipmentAction,
  deleteExclusionAction,
} from "@/app/actions/profile-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import { EQUIPMENT_VOCABULARY } from "@/domain/vocabulary";

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
  readonly severity: string;
  readonly matches: string[];
}

export interface NamedRow {
  readonly id: string;
  readonly name: string;
  readonly matches?: string[];
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
  const router = useRouter();

  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);

  const [allergenName, setAllergenName] = useState("");
  const [allergenSeverity, setAllergenSeverity] = useState("strict");
  const [allergenMatches, setAllergenMatches] = useState("");
  const [exclusionName, setExclusionName] = useState("");
  const [exclusionMatches, setExclusionMatches] = useState("");
  const [customEquipment, setCustomEquipment] = useState("");

  async function run(action: () => Promise<{ ok: boolean; code?: string; message?: string }>) {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: { code: result.code ?? "INTERNAL", message: result.message ?? "" },
      });
      return false;
    }
    setFeedback({});
    router.refresh();
    return true;
  }

  const declared = new Set(equipment.map((row) => row.key));
  const field =
    "rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20";

  return (
    <div className="flex flex-col gap-8">
      <Feedback {...feedback} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
            {t("allergens")}
          </h2>
          <p className="max-w-2xl text-xs opacity-70">{t("allergensHelp")}</p>
        </div>

        {allergens.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {allergens.map((allergen) => (
              <li
                key={allergen.id}
                className="flex flex-wrap items-baseline gap-2 rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/15"
              >
                <span className="font-medium">{allergen.name}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    allergen.severity === "strict"
                      ? "bg-red-500/15 text-red-800 dark:text-red-300"
                      : "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                  }`}
                >
                  {allergen.severity === "strict"
                    ? t("severityStrict")
                    : t("severityAvoid")}
                </span>
                {allergen.matches.length > 0 ? (
                  <span className="text-xs opacity-60">
                    {allergen.matches.join(", ")}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void run(() => deleteAllergenAction(allergen.id))
                  }
                  className="ml-auto text-xs underline opacity-60 disabled:opacity-30"
                >
                  {common("delete")}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">{t("allergenName")}</span>
            <input
              value={allergenName}
              onChange={(event) => setAllergenName(event.target.value)}
              className={`w-full ${field}`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("allergenSeverity")}</span>
            <select
              value={allergenSeverity}
              onChange={(event) => setAllergenSeverity(event.target.value)}
              className={field}
            >
              <option value="strict">{t("severityStrict")}</option>
              <option value="avoid">{t("severityAvoid")}</option>
            </select>
          </label>
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">{t("matches")}</span>
            <input
              value={allergenMatches}
              onChange={(event) => setAllergenMatches(event.target.value)}
              className={`w-full ${field}`}
            />
            <span className="text-xs opacity-70">{t("matchesHelp")}</span>
          </label>
          <button
            type="button"
            disabled={pending || allergenName.trim().length === 0}
            onClick={async () => {
              const ok = await run(() =>
                createAllergenAction({
                  name: allergenName.trim(),
                  severity: allergenSeverity,
                  matches: splitList(allergenMatches),
                }),
              );
              if (ok) {
                setAllergenName("");
                setAllergenMatches("");
              }
            }}
            className="rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
          >
            {common("add")}
          </button>
        </div>

        <p className="text-xs opacity-70">{t("strictWarning")}</p>
      </section>

      <section className="flex flex-col gap-3 border-t border-black/10 pt-6 dark:border-white/15">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
            {t("exclusions")}
          </h2>
          <p className="text-xs opacity-70">{t("exclusionsHelp")}</p>
        </div>

        {exclusions.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {exclusions.map((exclusion) => (
              <li
                key={exclusion.id}
                className="flex items-center gap-2 rounded-md border border-black/10 px-2 py-1 text-sm dark:border-white/15"
              >
                <span>{exclusion.name}</span>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={common("delete")}
                  onClick={() =>
                    void run(() => deleteExclusionAction(exclusion.id))
                  }
                  className="text-xs opacity-50 hover:opacity-100 disabled:opacity-30"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">{t("exclusions")}</span>
            <input
              value={exclusionName}
              onChange={(event) => setExclusionName(event.target.value)}
              className={`w-full ${field}`}
            />
          </label>
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">{t("matches")}</span>
            <input
              value={exclusionMatches}
              onChange={(event) => setExclusionMatches(event.target.value)}
              className={`w-full ${field}`}
            />
          </label>
          <button
            type="button"
            disabled={pending || exclusionName.trim().length === 0}
            onClick={async () => {
              const ok = await run(() =>
                createExclusionAction({
                  name: exclusionName.trim(),
                  matches: splitList(exclusionMatches),
                }),
              );
              if (ok) {
                setExclusionName("");
                setExclusionMatches("");
              }
            }}
            className="rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
          >
            {common("add")}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3 border-t border-black/10 pt-6 dark:border-white/15">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
            {t("equipment")}
          </h2>
          <p className="text-xs opacity-70">{t("equipmentHelp")}</p>
        </div>

        <ul className="flex flex-wrap gap-2">
          {EQUIPMENT_VOCABULARY.map((item) => {
            const owned = equipment.find((row) => row.key === item.key);
            return (
              <li key={item.key}>
                <button
                  type="button"
                  disabled={pending}
                  aria-pressed={declared.has(item.key)}
                  onClick={() =>
                    void run(() =>
                      owned
                        ? deleteEquipmentAction(owned.id)
                        : createEquipmentAction({
                            key: item.key,
                            label: item.label,
                          }),
                    )
                  }
                  className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
                    declared.has(item.key)
                      ? "border-emerald-600/50 bg-emerald-500/10"
                      : "border-black/15 opacity-70 dark:border-white/20"
                  }`}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>

        {equipment.filter(
          (row) => !EQUIPMENT_VOCABULARY.some((item) => item.key === row.key),
        ).length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {equipment
              .filter(
                (row) =>
                  !EQUIPMENT_VOCABULARY.some((item) => item.key === row.key),
              )
              .map((row) => (
                <li
                  key={row.id}
                  className="flex items-center gap-2 rounded-md border border-emerald-600/50 bg-emerald-500/10 px-2 py-1 text-sm"
                >
                  <span>{row.label ?? row.key}</span>
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={common("delete")}
                    onClick={() =>
                      void run(() => deleteEquipmentAction(row.id))
                    }
                    className="text-xs opacity-50 hover:opacity-100 disabled:opacity-30"
                  >
                    ×
                  </button>
                </li>
              ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">{t("equipmentOther")}</span>
            <input
              value={customEquipment}
              onChange={(event) => setCustomEquipment(event.target.value)}
              className={`w-full ${field}`}
            />
          </label>
          <button
            type="button"
            disabled={pending || customEquipment.trim().length === 0}
            onClick={async () => {
              const label = customEquipment.trim();
              const ok = await run(() =>
                createEquipmentAction({ key: slugify(label), label }),
              );
              if (ok) setCustomEquipment("");
            }}
            className="rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
          >
            {common("add")}
          </button>
        </div>
      </section>
    </div>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function slugify(label: string): string {
  return (
    label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "equipement"
  );
}
