"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  createMealTypeAction,
  deleteMealTypeAction,
  renameMealTypeAction,
  setSlotConfigAction,
} from "@/app/actions/slot-actions";
import { Feedback } from "@/components/feedback";
import { slugify } from "@/domain/slug";
import type { SlotDefinition } from "@/domain/slots";
import type { SlotState } from "@/domain/vocabulary";
import { ISO_DAYS } from "@/domain/week";
import { parseSlotKey, slotKey } from "@/lib/slot-key";
import { useActionRunner, type ActionRunner } from "@/lib/use-action-runner";

/**
 * The visual week editor, not a form: the grid is the thing being configured,
 * so the grid is what you click. One click cycles a cell through planned,
 * skipped and hidden; selecting a cell opens its time budget and default
 * servings.
 *
 * Changing this never touches an existing plan version. Each version carries
 * the grid it was made with, so past weeks keep the shape they were planned in.
 *
 * The cells are rendered from the `slots` prop with the result of the last
 * local write held as an overlay, rather than copied into state at mount. The
 * copy never resynchronised, so a grid an agent changed over MCP kept rendering
 * whatever this component saw when it loaded.
 */

interface MealTypeRow {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}

interface CellState {
  readonly state: SlotState;
  readonly timeBudgetMin: number | null;
  readonly defaultServings: number | null;
}

const NEXT_STATE: Record<SlotState, SlotState> = {
  planned: "skipped",
  skipped: "hidden",
  hidden: "planned",
};

const HIDDEN_CELL: CellState = {
  state: "hidden",
  timeBudgetMin: null,
  defaultServings: null,
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
  const runner = useActionRunner();

  /*
   * Local writes, keyed by the props array they were made against, so the
   * server's next render discards them in the same render that arrives. The
   * previous version seeded `useState` from `slots` and never looked at the
   * prop again.
   */
  const [overlay, setOverlay] = useState<{
    readonly of: readonly SlotDefinition[];
    readonly cells: Readonly<Record<string, CellState>>;
  } | null>(null);

  const serverCells: Readonly<Record<string, CellState>> = Object.fromEntries(
    slots.map((slot) => [
      slotKey(slot.dayOfWeek, slot.mealTypeId),
      {
        state: slot.state,
        timeBudgetMin: slot.timeBudgetMin,
        defaultServings: slot.defaultServings,
      },
    ]),
  );
  const cells =
    overlay !== null && overlay.of === slots
      ? { ...serverCells, ...overlay.cells }
      : serverCells;

  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function cellOf(dayOfWeek: number, mealTypeId: string): CellState {
    // A (day, meal) with no row is hidden: adding a meal type should not
    // scatter seven empty cells across the week until the user places it.
    return cells[slotKey(dayOfWeek, mealTypeId)] ?? HIDDEN_CELL;
  }

  function save(dayOfWeek: number, mealTypeId: string, next: CellState): void {
    const key = slotKey(dayOfWeek, mealTypeId);
    // Optimistic, and rolled back by the server's own render if refused: the
    // overlay is dropped the moment `slots` changes identity, and a refusal
    // leaves the previous props in place.
    setOverlay((previous) => ({
      of: slots,
      cells: {
        ...(previous !== null && previous.of === slots ? previous.cells : {}),
        [key]: next,
      },
    }));

    void runner.run(
      () =>
        setSlotConfigAction({
          dayOfWeek,
          mealTypeId,
          state: next.state,
          timeBudgetMin: next.timeBudgetMin,
          defaultServings: next.defaultServings,
        }),
      { onSuccess: () => setSaved(true) },
    );
  }

  const selectedCell = selected ? parseSlotKey(selected) : null;
  const selectedMeal = selectedCell
    ? mealTypes.find((meal) => meal.id === selectedCell.mealTypeId)
    : null;

  return (
    <div className="flex flex-col gap-5">
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      {saved && runner.feedback === null ? (
        <p className="banner banner-ok" aria-live="polite">
          {t("saved")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="chip chip-ok">{t("statePlanned")}</span>
        <span className="chip chip-warn">{t("stateSkipped")}</span>
        <span className="chip">{t("stateHidden")}</span>
      </div>

      <div className="ledger overflow-x-auto rounded-[3px] border border-rule bg-surface p-3">
        <table className="w-full min-w-[44rem] border-separate border-spacing-1.5 text-sm">
          <thead>
            <tr>
              <th className="eyebrow w-40 pb-2 text-left">{t("mealTypes")}</th>
              {ISO_DAYS.map((day) => (
                <th key={day} className="eyebrow pb-2">
                  {days(String(day))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mealTypes.map((meal) => (
              <tr key={meal.id}>
                <MealTypeHeader meal={meal} runner={runner} />
                {ISO_DAYS.map((day) => {
                  const cell = cellOf(day, meal.id);
                  const key = slotKey(day, meal.id);
                  return (
                    <td key={key}>
                      <button
                        type="button"
                        disabled={runner.pending}
                        aria-label={`${days(String(day))} ${meal.label}: ${stateLabel(t, cell.state)}. ${t("cycleState")}`}
                        onClick={() =>
                          save(day, meal.id, {
                            ...cell,
                            state: NEXT_STATE[cell.state],
                          })
                        }
                        className={`w-full rounded-[2px] border px-2 py-4 text-[0.7rem] transition-colors ${stateClass(cell.state)}`}
                      >
                        <span className="block font-medium">
                          {stateLabel(t, cell.state)}
                        </span>
                        {cell.state === "planned" &&
                        cell.timeBudgetMin !== null ? (
                          <span className="micro block pt-0.5">
                            {common("minutes", { count: cell.timeBudgetMin })}
                          </span>
                        ) : null}
                      </button>
                      {cell.state === "planned" ? (
                        <button
                          type="button"
                          onClick={() =>
                            setSelected(selected === key ? null : key)
                          }
                          className="link mt-1 w-full text-[0.65rem] text-muted"
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
        /*
         * Keyed by the selected cell, so both inputs remount when a different
         * cell is opened. They set `defaultValue`, which React applies only on
         * mount: without the key, opening a second cell kept showing the first
         * cell's budget and servings, and a blur then wrote those numbers into
         * the wrong slot.
         */
        <SlotDetails
          key={selected}
          cell={cellOf(selectedCell.dayOfWeek, selectedCell.mealTypeId)}
          dayLabel={days(String(selectedCell.dayOfWeek))}
          mealLabel={selectedMeal.label}
          onClose={() => setSelected(null)}
          onChange={(next) =>
            save(selectedCell.dayOfWeek, selectedCell.mealTypeId, next)
          }
        />
      ) : null}

      <AddMealType count={mealTypes.length} runner={runner} />
    </div>
  );
}

/**
 * A meal type's row head: its label, the key derived from it, and the two
 * things you can do to it.
 *
 * Rename and delete existed as server actions with no caller at all, which
 * meant a meal type created by a typo could never be corrected or removed.
 */
function MealTypeHeader({
  meal,
  runner,
}: {
  meal: MealTypeRow;
  runner: ActionRunner;
}) {
  const t = useTranslations("slots");
  const common = useTranslations("common");
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(meal.label);

  if (!editing) {
    return (
      <th className="text-left align-top font-normal">
        <span className="display block text-[0.95rem]">{meal.label}</span>
        <span className="micro block">
          {t("mealTypeKey")} <code className="mono">{meal.key}</code>
        </span>
        <span className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={runner.pending}
            onClick={() => {
              setLabel(meal.label);
              setEditing(true);
            }}
            className="link text-[0.65rem] text-muted"
          >
            {common("edit")}
          </button>
          <button
            type="button"
            disabled={runner.pending}
            onClick={() => void runner.run(() => deleteMealTypeAction(meal.id))}
            className="link text-[0.65rem] text-muted"
          >
            {common("delete")}
          </button>
        </span>
      </th>
    );
  }

  return (
    <th className="text-left align-top font-normal">
      <label className="label">
        <span>{t("mealTypeLabel")}</span>
        <input
          value={label}
          autoFocus
          onChange={(event) => setLabel(event.target.value)}
          className="field"
        />
      </label>
      <span className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={runner.pending || label.trim().length === 0}
          onClick={() =>
            void runner
              .run(() => renameMealTypeAction(meal.id, label.trim()))
              .then((result) => {
                if (result?.ok) setEditing(false);
              })
          }
          className="link text-[0.65rem]"
        >
          {common("save")}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="link text-[0.65rem] text-muted"
        >
          {common("cancel")}
        </button>
      </span>
    </th>
  );
}

/** The budget and servings of one selected cell. Remounted per cell by key. */
function SlotDetails({
  cell,
  dayLabel,
  mealLabel,
  onClose,
  onChange,
}: {
  cell: CellState;
  dayLabel: string;
  mealLabel: string;
  onClose: () => void;
  onChange: (next: CellState) => void;
}) {
  const t = useTranslations("slots");
  const common = useTranslations("common");

  return (
    <section className="slip flex flex-col gap-4 border-l-[3px] border-l-ember p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="display text-lg">
          {t("detailsFor", { day: dayLabel, meal: mealLabel })}
        </h2>
        <button type="button" onClick={onClose} className="link text-xs">
          {common("close")}
        </button>
      </div>

      <label className="label">
        <span>{t("timeBudget")}</span>
        <input
          type="number"
          min={0}
          max={600}
          defaultValue={cell.timeBudgetMin ?? ""}
          onBlur={(event) =>
            onChange({
              ...cell,
              timeBudgetMin: parseOptionalInt(event.target.value),
            })
          }
          className="w-32"
        />
        <span className="hint">{t("timeBudgetHelp")}</span>
      </label>

      <label className="label">
        <span>{t("defaultServings")}</span>
        <input
          type="number"
          min={1}
          max={50}
          defaultValue={cell.defaultServings ?? ""}
          onBlur={(event) =>
            onChange({
              ...cell,
              defaultServings: parseOptionalInt(event.target.value),
            })
          }
          className="w-32"
        />
      </label>
    </section>
  );
}

function AddMealType({
  count,
  runner,
}: {
  count: number;
  runner: ActionRunner;
}) {
  const t = useTranslations("slots");
  const common = useTranslations("common");
  const [label, setLabel] = useState("");

  return (
    <section className="flex flex-wrap items-end gap-2">
      <label className="label">
        <span>{t("addMealType")}</span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t("mealTypeLabel")}
          className="field"
        />
      </label>
      <button
        type="button"
        disabled={runner.pending || label.trim().length === 0}
        onClick={() => {
          const trimmed = label.trim();
          void runner
            .run(() =>
              createMealTypeAction({
                // `slugify` is the domain's, shared with the equipment editor.
                // Both components used to carry a copy, so an MCP caller could
                // derive a different key from the same label.
                key: slugify(trimmed, "repas"),
                label: trimmed,
                // Placed after the ones that already exist, which is the only
                // sensible default. Deriving it here is the client deciding a
                // stored ordering, and the service should assign it: see the
                // report accompanying this change.
                sortOrder: count,
              }),
            )
            .then((result) => {
              if (result?.ok) setLabel("");
            });
        }}
        className="btn btn-quiet"
      >
        {common("add")}
      </button>
    </section>
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

/**
 * The three states, told apart by ground as well as by colour: a planned cell
 * is filled, a skipped one is struck through with a hatch, a hidden one is a
 * dashed outline waiting to be brought into play.
 */
function stateClass(state: SlotState): string {
  if (state === "planned") {
    return "border-olive-line bg-olive-soft text-olive-ink";
  }
  if (state === "skipped") {
    return "hatched border-amber-line bg-amber-soft text-amber-ink";
  }
  return "border-dashed border-rule-strong text-faint";
}

function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
