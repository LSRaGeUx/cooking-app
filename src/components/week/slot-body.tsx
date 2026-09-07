"use client";

import { useTranslations } from "next-intl";
import { useDroppable } from "@dnd-kit/core";
import { slotKey } from "@/lib/slot-key";
import type { SlotDefinition } from "@/domain/slots";
import type { PlanEntryView } from "@/services/plan-service";
import { EntryBlock } from "./entry-block";

/**
 * One slot, wherever it is drawn. Both layouts render this, so a cell in the
 * wall and a row on a phone are the same object with the same drop target and
 * the same affordances.
 */
export function SlotBody({
  slot,
  entries,
  activeTimeByRecipeId,
  servesCount,
  sourceOf,
  unsourced,
  pending,
  onAssign,
  onOpen,
}: {
  slot: SlotDefinition;
  entries: readonly PlanEntryView[];
  activeTimeByRecipeId: Readonly<Record<string, number | null>>;
  servesCount: ReadonlyMap<string, number>;
  sourceOf: ReadonlyMap<string, string>;
  unsourced: ReadonlySet<string>;
  pending: boolean;
  onAssign: () => void;
  onOpen: (entryId: string) => void;
}) {
  const t = useTranslations("week");
  const common = useTranslations("common");

  const slotEntries = [...entries].sort((a, b) => a.position - b.position);

  if (slot.state === "skipped") {
    return (
      <div className="void flex min-h-16 items-center justify-center bg-panel p-3">
        <span className="label-text text-faint">{t("skippedSlot")}</span>
      </div>
    );
  }

  return (
    <SlotCell slotId={slotKey(slot.dayOfWeek, slot.mealTypeId)} slot={slot}>
      {slotEntries.length === 0 ? (
        <button
          type="button"
          disabled={pending}
          onClick={onAssign}
          className="fillable group flex h-full min-h-20 w-full flex-col items-center justify-center gap-1 bg-panel px-2 py-4"
        >
          <span aria-hidden="true" className="text-xl leading-none opacity-40">
            +
          </span>
          {/* Named, not just a glyph: an unlabelled square is a guess. */}
          <span className="label-text text-faint group-hover:text-current">
            {t("assign")}
          </span>
          {slot.timeBudgetMin !== null ? (
            <span className="label-text text-faint group-hover:text-current">
              {common("minutes", { count: slot.timeBudgetMin })}
            </span>
          ) : (
            <span className="label-text text-faint group-hover:text-current">
              {t("noBudget")}
            </span>
          )}
        </button>
      ) : (
        <div className="ruled flex h-full min-h-20 flex-col">
          {slotEntries.map((entry) => (
            <EntryBlock
              key={entry.id}
              entry={entry}
              activeTimeMin={
                entry.recipeId
                  ? (activeTimeByRecipeId[entry.recipeId] ?? null)
                  : null
              }
              budgetMin={slot.timeBudgetMin}
              servesOthers={servesCount.get(entry.id) ?? 0}
              reheated={sourceOf.has(entry.id)}
              unsourced={unsourced.has(entry.id)}
              onOpen={() => onOpen(entry.id)}
            />
          ))}
        </div>
      )}
    </SlotCell>
  );
}

function SlotCell({
  slotId,
  slot,
  children,
}: {
  slotId: string;
  slot: SlotDefinition;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: slotId });
  const days = useTranslations("week.days");

  return (
    <div
      ref={setNodeRef}
      // Spoken by a screen reader during a keyboard drag, so it has to name the
      // day rather than number it.
      aria-label={`${slot.mealTypeLabel}, ${days(String(slot.dayOfWeek))}`}
      className={`relative ${isOver ? "bg-ink" : ""}`}
    >
      {children}
    </div>
  );
}
