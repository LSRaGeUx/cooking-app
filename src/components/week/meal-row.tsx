"use client";

import { slotKey } from "@/lib/slot-key";
import type { SlotDefinition } from "@/domain/slots";
import { ISO_DAYS } from "@/domain/week";
import type { PlanEntryView } from "@/services/plan-service";
import { SlotBody } from "./slot-body";

/** One meal type across the seven days: a row of the wall. */
export function MealRow({
  meal,
  slots,
  entries,
  activeTimeByRecipeId,
  servesCount,
  sourceOf,
  unsourced,
  pending,
  onAssign,
  onOpen,
}: {
  meal: { id: string; label: string };
  slots: readonly SlotDefinition[];
  entries: readonly PlanEntryView[];
  activeTimeByRecipeId: Readonly<Record<string, number | null>>;
  servesCount: ReadonlyMap<string, number>;
  sourceOf: ReadonlyMap<string, string>;
  unsourced: ReadonlySet<string>;
  pending: boolean;
  onAssign: (slotId: string) => void;
  onOpen: (entryId: string) => void;
}) {
  return (
    <>
      <div className="block sticky left-0 z-10 flex flex-col justify-center gap-1 px-3 py-4">
        <span className="label-text">{meal.label}</span>
      </div>

      {ISO_DAYS.map((day) => {
        const slot = slots.find(
          (candidate) =>
            candidate.dayOfWeek === day && candidate.mealTypeId === meal.id,
        );
        const key = slotKey(day, meal.id);

        if (!slot) {
          // A meal type that was never set up on this day. Drawn as nothing at
          // all rather than as an empty invitation.
          return <div key={key} className="bg-sunk" />;
        }

        return (
          <SlotBody
            key={key}
            slot={slot}
            entries={entries.filter(
              (entry) =>
                entry.dayOfWeek === day && entry.mealTypeId === meal.id,
            )}
            activeTimeByRecipeId={activeTimeByRecipeId}
            servesCount={servesCount}
            sourceOf={sourceOf}
            unsourced={unsourced}
            pending={pending}
            onAssign={() => onAssign(key)}
            onOpen={onOpen}
          />
        );
      })}
    </>
  );
}
