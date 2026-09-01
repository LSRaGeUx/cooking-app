"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createMealTypeAction,
  setSlotConfigAction,
} from "@/app/actions/slot-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import type { SlotDefinition, SlotState } from "@/domain/slots";
import { ISO_DAYS } from "@/domain/week";

/**
 * The visual week editor, not a form: the grid is the thing being configured,
 * so the grid is what you click. One click cycles a cell through planned,
 * skipped and hidden; selecting a cell opens its time budget and default
 * servings.
 *
 * Changing this never touches an existing plan version. Each version carries
 * the grid it was made with, so past weeks keep the shape they were planned in.
 */

interface MealTypeRow {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}

interface CellState {
  state: SlotState;
  timeBudgetMin: number | null;
  defaultServings: number | null;
}

const NEXT_STATE: Record<SlotState, SlotState> = {
  planned: "skipped",
  skipped: "hidden",
  hidden: "planned",
};

export function SlotEditor({
  mealTypes,
  slots,
}: {
  mealTypes: readonly MealTypeRow[];
  slots: readonly SlotDefinition[];
}) {
  const t = useTranslations("slots");
  const common = useTranslations("common");
  const days = useTranslations("week.days");
  const router = useRouter();

  const [cells, setCells] = useState<Record<string, CellState>>(() =>
    Object.fromEntries(
      slots.map((slot) => [
        cellKey(slot.dayOfWeek, slot.mealTypeId),
        {
          state: slot.state,
          timeBudgetMin: slot.timeBudgetMin,
          defaultServings: slot.defaultServings,
        },
      ]),
    ),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);
  const [newMealLabel, setNewMealLabel] = useState("");

  function cellOf(dayOfWeek: number, mealTypeId: string): CellState {
    // A (day, meal) with no row is hidden: adding a meal type should not
    // scatter seven empty cells across the week until the user places it.
    return (
      cells[cellKey(dayOfWeek, mealTypeId)] ?? {
        state: "hidden",
        timeBudgetMin: null,
        defaultServings: null,
      }
    );
  }

  async function save(
    dayOfWeek: number,
    mealTypeId: string,
    next: CellState,
  ): Promise<void> {
    const key = cellKey(dayOfWeek, mealTypeId);
    const previous = cellOf(dayOfWeek, mealTypeId);
    setCells((current) => ({ ...current, [key]: next }));
    setPending(true);

    const result = await setSlotConfigAction({
      dayOfWeek,
      mealTypeId,
      state: next.state,
      timeBudgetMin: next.timeBudgetMin,
      defaultServings: next.defaultServings,
    });

    setPending(false);
    if (!result.ok) {
      // Put the cell back: the screen must show what is stored, not what was
      // attempted.
      setCells((current) => ({ ...current, [key]: previous }));
      setFeedback({
        error: {
          code: result.code,
          message: result.message,
          details: result.details,
        },
      });
      return;
    }
    setFeedback({});
    router.refresh();
  }

  async function addMealType(): Promise<void> {
    const label = newMealLabel.trim();
    if (label.length === 0) return;
    setPending(true);
    const result = await createMealTypeAction({
      key: slugify(label),
      label,
      sortOrder: mealTypes.length,
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
    setNewMealLabel("");
    setFeedback({});
    router.refresh();
  }

  const selectedCell = selected ? parseCellKey(selected) : null;
  const selectedMeal = selectedCell
    ? mealTypes.find((meal) => meal.id === selectedCell.mealTypeId)
    : null;

  return (
    <div className="flex flex-col gap-5">
      <Feedback {...feedback} />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th className="w-32 text-left text-xs font-medium opacity-60">
                {t("mealTypes")}
              </th>
              {ISO_DAYS.map((day) => (
                <th key={day} className="text-xs font-medium opacity-60">
                  {days(String(day))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mealTypes.map((meal) => (
              <tr key={meal.id}>
                <th className="text-left text-sm font-medium">{meal.label}</th>
                {ISO_DAYS.map((day) => {
                  const cell = cellOf(day, meal.id);
                  const key = cellKey(day, meal.id);
                  return (
                    <td key={key}>
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={`${days(String(day))} ${meal.label}: ${stateLabel(t, cell.state)}`}
                        onClick={() =>
                          void save(day, meal.id, {
                            ...cell,
                            state: NEXT_STATE[cell.state],
                          })
                        }
                        onDoubleClick={() => setSelected(key)}
                        className={`w-full rounded-md border px-2 py-3 text-xs transition-colors ${stateClass(cell.state)}`}
                      >
                        <span className="block">{stateLabel(t, cell.state)}</span>
                        {cell.state === "planned" && cell.timeBudgetMin !== null ? (
                          <span className="block opacity-70">
                            {common("minutes", { count: cell.timeBudgetMin })}
                          </span>
                        ) : null}
                      </button>
                      {cell.state === "planned" ? (
                        <button
                          type="button"
                          onClick={() => setSelected(selected === key ? null : key)}
                          className="mt-0.5 w-full text-[11px] underline opacity-60"
                        >
                          {common("edit")}
                        </button>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedCell && selectedMeal ? (
        <section className="flex flex-col gap-3 rounded-md border border-black/15 p-4 dark:border-white/20">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium">
              {t("detailsFor", {
                day: days(String(selectedCell.dayOfWeek)),
                meal: selectedMeal.label,
              })}
            </h2>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-xs underline"
            >
              {common("close")}
            </button>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("timeBudget")}</span>
            <input
              type="number"
              min={0}
              max={600}
              defaultValue={
                cellOf(selectedCell.dayOfWeek, selectedCell.mealTypeId)
                  .timeBudgetMin ?? ""
              }
              onBlur={(event) =>
                void save(selectedCell.dayOfWeek, selectedCell.mealTypeId, {
                  ...cellOf(selectedCell.dayOfWeek, selectedCell.mealTypeId),
                  timeBudgetMin: parseOptionalInt(event.target.value),
                })
              }
              className="w-32 rounded-md border border-black/15 px-2 py-1 dark:border-white/20"
            />
            <span className="text-xs opacity-70">{t("timeBudgetHelp")}</span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("defaultServings")}</span>
            <input
              type="number"
              min={1}
              max={50}
              defaultValue={
                cellOf(selectedCell.dayOfWeek, selectedCell.mealTypeId)
                  .defaultServings ?? ""
              }
              onBlur={(event) =>
                void save(selectedCell.dayOfWeek, selectedCell.mealTypeId, {
                  ...cellOf(selectedCell.dayOfWeek, selectedCell.mealTypeId),
                  defaultServings: parseOptionalInt(event.target.value),
                })
              }
              className="w-32 rounded-md border border-black/15 px-2 py-1 dark:border-white/20"
            />
          </label>
        </section>
      ) : null}

      <section className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("addMealType")}</span>
          <input
            value={newMealLabel}
            onChange={(event) => setNewMealLabel(event.target.value)}
            placeholder={t("mealTypeLabel")}
            className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
          />
        </label>
        <button
          type="button"
          disabled={pending || newMealLabel.trim().length === 0}
          onClick={() => void addMealType()}
          className="rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
        >
          {common("add")}
        </button>
      </section>
    </div>
  );
}

function stateLabel(
  t: ReturnType<typeof useTranslations>,
  state: SlotState,
): string {
  if (state === "planned") return t("statePlanned");
  if (state === "skipped") return t("stateSkipped");
  return t("stateHidden");
}

function stateClass(state: SlotState): string {
  if (state === "planned") {
    return "border-emerald-600/50 bg-emerald-500/10";
  }
  if (state === "skipped") {
    return "border-amber-600/50 bg-amber-500/10";
  }
  return "border-black/10 bg-black/5 opacity-60 dark:border-white/10 dark:bg-white/5";
}

function cellKey(dayOfWeek: number, mealTypeId: string): string {
  return `${dayOfWeek}:${mealTypeId}`;
}

function parseCellKey(
  key: string,
): { dayOfWeek: number; mealTypeId: string } | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  return {
    dayOfWeek: Number(key.slice(0, separator)),
    mealTypeId: key.slice(separator + 1),
  };
}

function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Meal type keys are a stable vocabulary, so they are derived, not typed. */
function slugify(label: string): string {
  return (
    label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "repas"
  );
}
