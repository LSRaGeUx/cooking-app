"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { ActionResult } from "@/app/actions/result";
import {
  assignRecipeAction,
  clearEntryAction,
  duplicateEntryAction,
  moveEntryAction,
  updateEntryAction,
} from "@/app/actions/plan-actions";
import { EmptyState } from "@/components/empty-state";
import { gridKeyboardCoordinates } from "./keyboard-coordinates";
import { Feedback, type FeedbackState } from "@/components/feedback";
import type { DomainWarning } from "@/domain/errors";
import type { SlotDefinition } from "@/domain/slots";
import { ISO_DAYS, type IsoWeek } from "@/domain/week";
import { sealClass } from "@/lib/recipe-seal";
import { useMediaQuery } from "@/lib/use-media-query";
import type { PlanEntryView, WriteResult } from "@/services/plan-service";
import type { PrepLinkView } from "@/services/prep-service";
import { linkPrepAction, unlinkPrepAction } from "@/app/actions/prep-actions";
import { EntryPanel } from "./entry-panel";
import { RecipePicker, type PickableRecipe } from "./recipe-picker";

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
  const router = useRouter();

  // Two structures, never both mounted: they share droppable ids, and two
  // droppables with the same id is a silent drag-and-drop bug.
  const wide = useMediaQuery("(min-width: 1024px)");

  const [entries, setEntries] = useState<readonly PlanEntryView[]>(serverEntries);
  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  // The server is the authority: when a revalidation brings new entries in,
  // local state follows rather than the other way round.
  useEffect(() => {
    setEntries(serverEntries);
  }, [serverEntries]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: gridKeyboardCoordinates }),
  );

  async function run(
    action: () => Promise<ActionResult<WriteResult>>,
  ): Promise<void> {
    setPending(true);
    const result = await action();
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

    setEntries(result.data.entries);
    setFeedback({ warnings: result.data.warnings as DomainWarning[] });
    setPickerSlot(null);
    setOpenEntryId(null);
    router.refresh();
  }

  /**
   * For writes that do not return a new plan version, such as a prep link. The
   * server stays the authority: the screen re-reads rather than guessing.
   */
  async function runPlain(
    action: () => Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: {
          code: result.code ?? "INTERNAL",
          message: result.message ?? "",
          details: result.details,
        },
      });
      return;
    }
    setFeedback({});
    setOpenEntryId(null);
    router.refresh();
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
    void run(() => moveEntryAction(week, entryId, parsed));
  }

  const sourceOf = new Map(
    prepLinks
      .filter((link) => link.sourceEntryId !== null)
      .map((link) => [link.dependentEntryId, link.sourceEntryId!]),
  );
  const servesCount = new Map<string, number>();
  for (const link of prepLinks) {
    if (!link.sourceEntryId) continue;
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

  const onAssign = (key: string) => () => setPickerSlot(key);
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
      {feedback.error || (feedback.warnings?.length ?? 0) > 0 ? (
        <div className="band px-5 py-3 lg:px-8">
          <Feedback {...feedback} />
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
                    isToday ? "block-tomato" : "block"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="label-text">{days(String(day))}</span>
                    <span className="numeral text-xl">
                      {dayNumbers[String(day)]}
                    </span>
                  </span>
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
                pending={pending}
                onAssign={(key) => setPickerSlot(key)}
                onOpen={(id) => setOpenEntryId(id)}
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
                  (row): row is { meal: typeof mealRows[number]; slot: SlotDefinition } =>
                    row.slot !== undefined,
                );
              if (daySlots.length === 0) return null;
              const isToday = todayDayOfWeek === day;

              return (
                <section key={day}>
                  <header
                    className={`flex items-baseline justify-between gap-3 border-b-2 border-rule px-5 py-2 ${
                      isToday ? "block-tomato" : "block-ink"
                    }`}
                  >
                    <span className="label-text">
                      {days(String(day))}
                      {shoppingDayOfWeek === day ? ` · ${t("shoppingMark")}` : ""}
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
                            pending={pending}
                            onAssign={onAssign(slotKey(day, meal.id))}
                            onOpen={(id) => setOpenEntryId(id)}
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
                  disabled={pending}
                  onClick={() => void run(() => clearEntryAction(week, entry.id))}
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
        <Overlay onClose={() => setPickerSlot(null)}>
          <RecipePicker
            heading={`${days(String(pickerSlotDefinition.dayOfWeek))} ${pickerSlotDefinition.mealTypeLabel}`}
            initialRecipes={recipes}
            disabled={pending}
            onClose={() => setPickerSlot(null)}
            onPick={(recipeId) =>
              void run(() =>
                assignRecipeAction(week, {
                  dayOfWeek: pickerSlotDefinition.dayOfWeek,
                  mealTypeId: pickerSlotDefinition.mealTypeId,
                  recipeId,
                }),
              )
            }
          />
        </Overlay>
      ) : null}

      {openEntry ? (
        <Overlay onClose={() => setOpenEntryId(null)}>
          <EntryPanel
            entry={openEntry}
            slots={slots}
            disabled={pending}
            onClose={() => setOpenEntryId(null)}
            onSave={(changes) =>
              void run(() => updateEntryAction(week, openEntry.id, changes))
            }
            onDuplicate={(target) =>
              void run(() => duplicateEntryAction(week, openEntry.id, target))
            }
            onClear={() => void run(() => clearEntryAction(week, openEntry.id))}
            prepSourceId={sourceOf.get(openEntry.id) ?? null}
            // Only meals cooked the same day or earlier can feed this one: you
            // cannot eat on Tuesday what you cook on Thursday.
            prepCandidates={entries
              .filter(
                (row) =>
                  row.id !== openEntry.id &&
                  row.dayOfWeek <= openEntry.dayOfWeek,
              )
              .map((row) => ({
                entryId: row.id,
                dayOfWeek: row.dayOfWeek,
                label: `${days(String(row.dayOfWeek))} · ${row.recipeTitleSnapshot}`,
              }))}
            onLinkPrep={(sourceEntryId) =>
              void runPlain(() =>
                linkPrepAction(week, sourceEntryId, openEntry.id),
              )
            }
            onUnlinkPrep={() =>
              void runPlain(() => unlinkPrepAction(week, openEntry.id))
            }
          />
        </Overlay>
      ) : null}
    </div>
  );
}

/** A modal block. Bottom sheet on a phone, centred slab on a desk. */
function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const common = useTranslations("common");

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label={common("close")}
        onClick={onClose}
        className="backdrop"
      />
      <div className="relative w-full max-w-lg border-2 border-rule bg-panel">
        {children}
      </div>
    </div>
  );
}

function MealRow({
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
  servesCount: Map<string, number>;
  sourceOf: Map<string, string>;
  unsourced: Set<string>;
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

/**
 * One slot, wherever it is drawn. Both layouts render this, so a cell in the
 * wall and a row on a phone are the same object with the same drop target and
 * the same affordances.
 */
function SlotBody({
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
  servesCount: Map<string, number>;
  sourceOf: Map<string, string>;
  unsourced: Set<string>;
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
          ) : null}
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

function EntryBlock({
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
              {t("prepLinkNone")}
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

function slotKey(dayOfWeek: number, mealTypeId: string): string {
  return `${dayOfWeek}:${mealTypeId}`;
}

function parseSlotKey(
  key: string,
): { dayOfWeek: number; mealTypeId: string } | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const dayOfWeek = Number(key.slice(0, separator));
  const mealTypeId = key.slice(separator + 1);
  if (!Number.isInteger(dayOfWeek) || mealTypeId.length === 0) return null;
  return { dayOfWeek, mealTypeId };
}
