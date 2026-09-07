"use client";

import { useTranslations } from "next-intl";
import { useDraggable } from "@dnd-kit/core";
import { sealClass } from "@/lib/recipe-seal";
import type { PlanEntryView } from "@/services/plan-service";

/**
 * One planned meal, drawn in its recipe's own colour.
 *
 * Split out of week-grid.tsx, which held six components in 811 lines. Nothing
 * about the markup changed in the move.
 */
export function EntryBlock({
  entry,
  activeTimeMin,
  budgetMin,
  servesOthers,
  reheated,
  unsourced,
  onOpen,
}: {
  entry: PlanEntryView;
  activeTimeMin: number | null;
  budgetMin: number | null;
  servesOthers: number;
  reheated: boolean;
  unsourced: boolean;
  onOpen: () => void;
}) {
  const common = useTranslations("common");
  const t = useTranslations("week");
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: entry.id });

  // The colour belongs to the recipe, so the same dish is the same colour in
  // the library, in the week and on the shopping list. An entry whose recipe is
  // gone falls back to its own id rather than losing the mark entirely.
  const seal = sealClass(entry.recipeId ?? entry.id);
  const over =
    budgetMin !== null && activeTimeMin !== null && activeTimeMin > budgetMin;
  const fill =
    budgetMin === null || activeTimeMin === null
      ? 0
      : Math.min(activeTimeMin / budgetMin, 1) * 100;

  return (
    <div
      ref={setNodeRef}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      className={`${seal} seal-field relative flex flex-1 flex-col ${
        isDragging ? "opacity-70" : ""
      }`}
    >
      {/*
        The handle carries the drag, not the whole block. Spreading the
        listeners on the block would put a keyboard drag and the "open this
        meal" button on the same element, and space would do one of two things
        depending on where focus happened to be.
      */}
      <button
        type="button"
        aria-label={t("dragHandle", { title: entry.recipeTitleSnapshot })}
        className="absolute right-0 top-0 cursor-grab touch-none px-2 py-1.5 text-xs leading-none opacity-50 hover:opacity-100"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>

      <button
        type="button"
        onClick={onOpen}
        className="flex flex-1 flex-col gap-1 p-3 pr-7 text-left"
      >
        <span className="name text-[0.95rem]">{entry.recipeTitleSnapshot}</span>
        <span className="text-xs opacity-70">
          {common("servings", { count: entry.servings })}
          {activeTimeMin !== null
            ? ` · ${common("minutes", { count: activeTimeMin })}`
            : ""}
        </span>

        <span className="mt-auto flex flex-wrap gap-1 pt-1.5">
          {servesOthers > 0 ? (
            <span className="chip border-current bg-transparent text-current">
              {t("prepSource", { count: servesOthers })}
            </span>
          ) : null}
          {reheated ? (
            <span className="chip border-current bg-transparent text-current">
              {t("prepDependent")}
            </span>
          ) : null}
          {unsourced ? (
            <span className="chip chip-warn">{t("prepUnsourced")}</span>
          ) : null}
        </span>
      </button>

      {/*
        Hands-on time against the slot budget, as a bar along the foot of the
        block. It runs red past the budget, which is the case worth seeing.
      */}
      {budgetMin !== null && activeTimeMin !== null ? (
        <span
          aria-hidden="true"
          className="block h-1.5 w-full bg-black/15"
          title={t("budget", { count: budgetMin })}
        >
          <span
            className={`block h-full ${over ? "bg-red" : "bg-current"}`}
            style={{ width: over ? "100%" : `${fill}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
