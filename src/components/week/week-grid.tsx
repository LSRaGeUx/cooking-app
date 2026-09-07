"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  assignRecipeAction,
  clearEntryAction,
  duplicateEntryAction,
  moveEntryAction,
  updateEntryAction,
} from "@/app/actions/plan-actions";
import { linkPrepAction, unlinkPrepAction } from "@/app/actions/prep-actions";
import type { ActionResult } from "@/app/actions/result";
import { EmptyState } from "@/components/empty-state";
import { Feedback } from "@/components/feedback";
import { Modal } from "@/components/modal";
import { canServeFrom } from "@/domain/prep";
import type { SlotDefinition } from "@/domain/slots";
import { ISO_DAYS, isIsoDay, type IsoWeek } from "@/domain/week";
import { parseSlotKey, slotKey } from "@/lib/slot-key";
import { useActionRunner } from "@/lib/use-action-runner";
import { useMediaQuery } from "@/lib/use-media-query";
import type { PlanEntryView, WriteResult } from "@/services/plan-service";
import type { PrepLinkView } from "@/services/prep-service";
import { gridKeyboardCoordinates } from "./keyboard-coordinates";
import { EntryPanel } from "./entry-panel";
import { MealRow } from "./meal-row";
import { RecipePicker, type PickableRecipe } from "./recipe-picker";
import { SlotBody } from "./slot-body";

/**
 * The one screen that matters, drawn as a wall.
 *
 * Meal types are rows and days are columns, which is what the data actually is:
 * "dinner" is one thing across the week, not seven unrelated items inside seven
 * cards. A planned meal fills its cell with the recipe's own colour, an empty
 * planned slot is white, a skipped one is hatched, and a slot you never set up
 * is not drawn at all. The week is legible as a pattern before a single title
 * is read.
 *
 * Editing happens in an overlay rather than inside a cell, because a panel that
 * expands inside a lattice pushes every other cell out of alignment, and the
 * alignment is the whole point.
 *
 * Every mutation goes through a server action into the planning service, which
 * writes a new immutable version. The grid therefore never edits its own state
 * as the source of truth: it renders what the service returned, so a refused
 * write leaves the screen showing what is actually stored rather than an
 * optimistic lie the database rejected.
 *
 * The five components this file used to also contain now live beside it:
 * meal-row, slot-body, entry-block and the shared modal.
 */
export function WeekGrid({
  week,
  slots,
  entries: serverEntries,
  orphanedEntries,
  recipes,
  prepLinks,
  activeTimeByRecipeId,
  dayLabels,
  dayNumbers,
  todayDayOfWeek,
  shoppingDayOfWeek,
}: {
  week: IsoWeek;
  slots: readonly SlotDefinition[];
  entries: readonly PlanEntryView[];
  orphanedEntries: readonly PlanEntryView[];
  recipes: readonly PickableRecipe[];
  prepLinks: readonly PrepLinkView[];
  activeTimeByRecipeId: Readonly<Record<string, number | null>>;
  /** Formatted on the server so date formatting has one implementation. */
  dayLabels: Readonly<Record<string, string>>;
  /** Day of the month, printed at the head of each column. */
  dayNumbers: Readonly<Record<string, string>>;
  /** Null unless the displayed week is the one containing today. */
  todayDayOfWeek: number | null;
  /** The cook's weekly shopping day, or null when they have not set one. */
  shoppingDayOfWeek: number | null;
}) {
  const t = useTranslations("week");
  const days = useTranslations("week.days");
  const common = useTranslations("common");

  // Two structures, never both mounted: they share droppable ids, and two
  // droppables with the same id is a silent drag-and-drop bug.
  const wide = useMediaQuery("(min-width: 1024px)");

  const runner = useActionRunner();
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  /*
   * The entries a write just returned, held only until the server sends its
   * own. A plan write returns the new version's entries, and showing them
   * immediately is what makes a drop feel instant.
   *
   * Keyed by the props array it was derived from rather than synchronised in an
   * effect. The previous version copied `serverEntries` into state at mount and
   * then wrote it back in `useEffect`, which React's hooks lint now reports as
   * an error and which showed the old plan for one frame after every refresh.
   * Comparing identities during render means a new `serverEntries` discards the
   * overlay in the same render that introduces it, with no intermediate paint
   * and no effect.
   */
  const [overlay, setOverlay] = useState<{
    readonly of: readonly PlanEntryView[];
    readonly entries: readonly PlanEntryView[];
  } | null>(null);
  const entries =
    overlay !== null && overlay.of === serverEntries
      ? overlay.entries
      : serverEntries;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: gridKeyboardCoordinates }),
  );

  /** A plan write. Closes whatever panel asked for it, on success only. */
  function runWrite(action: () => Promise<ActionResult<WriteResult>>): void {
    void runner.run(action, {
      onSuccess: (data) => {
        setOverlay({ of: serverEntries, entries: data.entries });
        setPickerSlot(null);
        setOpenEntryId(null);
      },
    });
  }

  function onDragEnd(event: DragEndEvent): void {
    const entryId = String(event.active.id);
    const target = event.over ? String(event.over.id) : null;
    if (!target) return;

    const entry = entries.find((row) => row.id === entryId);
    if (!entry) return;
    if (target === slotKey(entry.dayOfWeek, entry.mealTypeId)) return;

    const parsed = parseSlotKey(target);
    if (!parsed) return;
    runWrite(() => moveEntryAction(week, entryId, parsed));
  }

  /*
   * A link with no source is a dependent meal whose cooking session was cleared
   * out from under it, which the banner reports. Filtered with a type guard
   * rather than asserted: `sourceEntryId` is nullable on the view, and the
   * non-null assertion this used to carry is the kind that survives a schema
   * change it should have failed on.
   */
  const sourced = prepLinks.filter(
    (link): link is PrepLinkView & { sourceEntryId: string } =>
      link.sourceEntryId !== null,
  );
  const sourceOf = new Map(
    sourced.map((link) => [link.dependentEntryId, link.sourceEntryId]),
  );
  const servesCount = new Map<string, number>();
  for (const link of sourced) {
    servesCount.set(
      link.sourceEntryId,
      (servesCount.get(link.sourceEntryId) ?? 0) + 1,
    );
  }
  const unsourced = new Set(
    prepLinks
      .filter((link) => link.sourceEntryId === null)
      .map((link) => link.dependentEntryId),
  );

  const plannedSlots = slots.filter((slot) => slot.state !== "hidden");

  if (plannedSlots.length === 0) {
    return (
      <EmptyState
        message={t("noPlannedSlots")}
        action={{ href: "/creneaux", label: t("configureSlots") }}
      />
    );
  }

  // Rows are meal types, in the order the slot service returns them, so a user
  // who moved breakfast below lunch sees it below lunch here too.
  const mealRows: { id: string; label: string }[] = [];
  for (const slot of plannedSlots) {
    if (mealRows.some((row) => row.id === slot.mealTypeId)) continue;
    mealRows.push({ id: slot.mealTypeId, label: slot.mealTypeLabel });
  }

  const openEntry = entries.find((entry) => entry.id === openEntryId) ?? null;
  const pickerParsed = pickerSlot ? parseSlotKey(pickerSlot) : null;
  const pickerSlotDefinition = pickerParsed
    ? (plannedSlots.find(
        (slot) =>
          slot.dayOfWeek === pickerParsed.dayOfWeek &&
          slot.mealTypeId === pickerParsed.mealTypeId,
      ) ?? null)
    : null;

  return (
    <div className="flex flex-col">
      {runner.feedback || runner.warnings.length > 0 ? (
        <div className="band px-5 py-3 lg:px-8">
          <Feedback error={runner.feedback} warnings={runner.warnings} />
        </div>
      ) : null}

      {unsourced.size > 0 ? (
        <p className="band bg-yellow px-5 py-3 text-ink lg:px-8">
          {t("prepUnsourcedBanner", { count: unsourced.size })}
        </p>
      ) : null}

      {/*
        A stable id, because dnd-kit otherwise numbers its aria-describedby
        targets from a global counter. The server renders the narrow layout and
        a wide client renders the wall, so the counters diverge and React
        reports a hydration mismatch on an attribute nobody can see.
      */}
      <DndContext
        id="week-grid"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        {wide ? (
          <div
            className="wall border-t-0"
            style={{
              gridTemplateColumns: "7.5rem repeat(7, minmax(0, 1fr))",
            }}
          >
            {/* Head row: the days. */}
            <div className="block sticky left-0 z-10" />
            {ISO_DAYS.map((day) => {
              const isToday = todayDayOfWeek === day;
              const isShoppingDay = shoppingDayOfWeek === day;
              return (
                <div
                  key={`head-${day}`}
                  className={`flex flex-col gap-0.5 px-3 py-2.5 ${
                    isToday ? "bg-tomato text-on-tomato" : "block"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="label-text">{days(String(day))}</span>
                    <span className="numeral text-xl">
                      {dayNumbers[String(day)]}
                    </span>
                  </span>
                  {isToday ? (
                    <span className="sr-only">{t("todayMark")}</span>
                  ) : null}
                  {/*
                    The shopping day, marked where you plan rather than only on
                    the shopping screen: everything from here on is bought on
                    this shop.
                  */}
                  {isShoppingDay ? (
                    <span className="label-text opacity-70">
                      {t("shoppingMark")}
                    </span>
                  ) : null}
                </div>
              );
            })}

            {/* One row per meal type, seven cells across. */}
            {mealRows.map((meal) => (
              <MealRow
                key={meal.id}
                meal={meal}
                slots={plannedSlots}
                entries={entries}
                activeTimeByRecipeId={activeTimeByRecipeId}
                servesCount={servesCount}
                sourceOf={sourceOf}
                unsourced={unsourced}
                pending={runner.pending}
                onAssign={setPickerSlot}
                onOpen={setOpenEntryId}
              />
            ))}
          </div>
        ) : (
          /*
           * Narrow: one band per day, meals stacked inside it. The wall needs
           * eight columns to mean anything, and eight columns on a phone is a
           * sideways scroll through your own week.
           */
          <div className="stack border-t-0">
            {ISO_DAYS.map((day) => {
              const daySlots = mealRows
                .map((meal) => ({
                  meal,
                  slot: plannedSlots.find(
                    (candidate) =>
                      candidate.dayOfWeek === day &&
                      candidate.mealTypeId === meal.id,
                  ),
                }))
                .filter(
                  (
                    row,
                  ): row is {
                    meal: { id: string; label: string };
                    slot: SlotDefinition;
                  } => row.slot !== undefined,
                );
              if (daySlots.length === 0) return null;
              const isToday = todayDayOfWeek === day;

              return (
                <section key={day}>
                  <header
                    className={`flex items-baseline justify-between gap-3 border-b-2 border-rule px-5 py-2 ${
                      isToday ? "bg-tomato text-on-tomato" : "block-ink"
                    }`}
                  >
                    <span className="label-text">
                      {days(String(day))}
                      {isToday ? ` · ${t("todayMark")}` : ""}
                      {shoppingDayOfWeek === day
                        ? ` · ${t("shoppingMark")}`
                        : ""}
                    </span>
                    <span className="label-text opacity-70">
                      {dayLabels[String(day)]}
                    </span>
                  </header>

                  <div className="stack border-t-0">
                    {daySlots.map(({ meal, slot }) => (
                      <div key={meal.id} className="flex items-stretch">
                        <span className="label-text flex w-28 shrink-0 items-center border-r-2 border-rule px-3 py-3">
                          {meal.label}
                        </span>
                        <div className="min-w-0 flex-1">
                          <SlotBody
                            slot={slot}
                            entries={entries.filter(
                              (entry) =>
                                entry.dayOfWeek === day &&
                                entry.mealTypeId === meal.id,
                            )}
                            activeTimeByRecipeId={activeTimeByRecipeId}
                            servesCount={servesCount}
                            sourceOf={sourceOf}
                            unsourced={unsourced}
                            pending={runner.pending}
                            onAssign={() =>
                              setPickerSlot(slotKey(day, meal.id))
                            }
                            onOpen={setOpenEntryId}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </DndContext>

      <p className="band bg-panel px-5 py-3 lg:px-8">
        <span className="hint">{t("dragHint")}</span>
      </p>

      {orphanedEntries.length > 0 ? (
        <section className="band bg-yellow px-5 py-4 text-ink lg:px-8">
          <h2 className="big">{t("orphaned")}</h2>
          <p className="hint text-ink">{t("orphanedHelp")}</p>
          <ul className="ruled mt-3 flex flex-col">
            {orphanedEntries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2">
                <span className="label-text">
                  {days(String(entry.dayOfWeek))}
                </span>
                <span className="name">{entry.recipeTitleSnapshot}</span>
                <button
                  type="button"
                  disabled={runner.pending}
                  onClick={() =>
                    runWrite(() => clearEntryAction(week, entry.id))
                  }
                  className="btn btn-sm ml-auto"
                >
                  {common("delete")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* --------------------------------------------------------- overlays */}
      {pickerSlot && pickerSlotDefinition ? (
        <Modal
          label={`${days(String(pickerSlotDefinition.dayOfWeek))} ${pickerSlotDefinition.mealTypeLabel}`}
          onClose={() => setPickerSlot(null)}
        >
          <RecipePicker
            heading={`${days(String(pickerSlotDefinition.dayOfWeek))} ${pickerSlotDefinition.mealTypeLabel}`}
            initialRecipes={recipes}
            disabled={runner.pending}
            onClose={() => setPickerSlot(null)}
            onPick={(recipeId) =>
              runWrite(() =>
                assignRecipeAction(week, {
                  dayOfWeek: pickerSlotDefinition.dayOfWeek,
                  mealTypeId: pickerSlotDefinition.mealTypeId,
                  recipeId,
                }),
              )
            }
          />
        </Modal>
      ) : null}

      {openEntry ? (
        <Modal label={t("editEntry")} onClose={() => setOpenEntryId(null)}>
          <EntryPanel
            entry={openEntry}
            slots={slots}
            disabled={runner.pending}
            onClose={() => setOpenEntryId(null)}
            onSave={(changes) =>
              runWrite(() => updateEntryAction(week, openEntry.id, changes))
            }
            onDuplicate={(target) =>
              runWrite(() => duplicateEntryAction(week, openEntry.id, target))
            }
            onClear={() => runWrite(() => clearEntryAction(week, openEntry.id))}
            prepSourceId={sourceOf.get(openEntry.id) ?? null}
            /*
             * Only meals cooked the same day or earlier can feed this one: you
             * cannot eat on Tuesday what you cook on Thursday. The rule is
             * `canServeFrom` in the domain, which is what the service enforces
             * when the link is written. It used to be a `<=` comparison
             * inlined here, so the list the user could pick from and the list
             * the server accepted were two statements of one rule.
             */
            prepCandidates={entries
              .filter(
                (row) =>
                  row.id !== openEntry.id &&
                  isIsoDay(row.dayOfWeek) &&
                  isIsoDay(openEntry.dayOfWeek) &&
                  canServeFrom(row.dayOfWeek, openEntry.dayOfWeek),
              )
              .map((row) => ({
                entryId: row.id,
                dayOfWeek: row.dayOfWeek,
                label: `${days(String(row.dayOfWeek))} · ${row.recipeTitleSnapshot}`,
              }))}
            onLinkPrep={(sourceEntryId) =>
              void runner.run(() =>
                linkPrepAction(week, sourceEntryId, openEntry.id),
              )
            }
            onUnlinkPrep={() =>
              void runner.run(() => unlinkPrepAction(week, openEntry.id))
            }
          />
        </Modal>
      ) : null}
    </div>
  );
}
