"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { SlotDefinition } from "@/domain/slots";
import type { PlanEntryView } from "@/services/plan-service";

/**
 * Servings, a note, duplicate to another slot, or clear. Duplicating to another
 * slot is how a user expresses leftovers before prep links exist, so it is a
 * first-class button rather than a hidden gesture.
 */
export function EntryPanel({
  entry,
  slots,
  disabled = false,
  onSave,
  onDuplicate,
  onClear,
  onClose,
}: {
  entry: PlanEntryView;
  slots: readonly SlotDefinition[];
  disabled?: boolean;
  onSave: (changes: { servings: number; note: string | null }) => void;
  onDuplicate: (target: { dayOfWeek: number; mealTypeId: string }) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("week");
  const common = useTranslations("common");
  const days = useTranslations("week.days");

  const [servings, setServings] = useState(entry.servings);
  const [note, setNote] = useState(entry.note ?? "");
  const [duplicateTarget, setDuplicateTarget] = useState("");

  const targets = slots.filter(
    (slot) =>
      slot.state === "planned" &&
      !(slot.dayOfWeek === entry.dayOfWeek && slot.mealTypeId === entry.mealTypeId),
  );

  return (
    <div
      role="dialog"
      aria-label={t("editEntry")}
      className="flex flex-col gap-3 rounded-md border border-black/15 bg-white p-3 shadow-lg dark:border-white/20 dark:bg-neutral-900"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{entry.recipeTitleSnapshot}</h3>
        <button type="button" onClick={onClose} className="text-xs underline">
          {common("close")}
        </button>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("servingsLabel")}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={servings}
          onChange={(event) => setServings(Number(event.target.value))}
          className="rounded-md border border-black/15 px-2 py-1 dark:border-white/20"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("noteLabel")}</span>
        <textarea
          value={note}
          rows={2}
          placeholder={t("notePlaceholder")}
          onChange={(event) => setNote(event.target.value)}
          className="rounded-md border border-black/15 px-2 py-1 dark:border-white/20"
        />
      </label>

      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onSave({ servings, note: note.trim().length > 0 ? note.trim() : null })
        }
        className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
      >
        {disabled ? common("saving") : common("save")}
      </button>

      <div className="flex flex-col gap-1 border-t border-black/10 pt-3 dark:border-white/15">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("duplicate")}</span>
          <select
            value={duplicateTarget}
            onChange={(event) => setDuplicateTarget(event.target.value)}
            className="rounded-md border border-black/15 px-2 py-1 dark:border-white/20"
          >
            <option value="">{common("none")}</option>
            {targets.map((slot) => (
              <option
                key={`${slot.dayOfWeek}:${slot.mealTypeId}`}
                value={`${slot.dayOfWeek}:${slot.mealTypeId}`}
              >
                {days(String(slot.dayOfWeek))} {slot.mealTypeLabel}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled || duplicateTarget === ""}
          onClick={() => {
            const [day, mealTypeId] = duplicateTarget.split(":");
            if (!day || !mealTypeId) return;
            onDuplicate({ dayOfWeek: Number(day), mealTypeId });
          }}
          className="self-start rounded-md border border-black/15 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/20"
        >
          {t("duplicate")}
        </button>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={onClear}
        className="self-start text-sm text-red-700 underline disabled:opacity-50 dark:text-red-400"
      >
        {t("clear")}
      </button>
    </div>
  );
}
