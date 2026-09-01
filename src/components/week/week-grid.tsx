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
import { Feedback, type FeedbackState } from "@/components/feedback";
import type { DomainWarning } from "@/domain/errors";
import type { SlotDefinition } from "@/domain/slots";
import { ISO_DAYS, type IsoWeek } from "@/domain/week";
import type { PlanEntryView, WriteResult } from "@/services/plan-service";
import { EntryPanel } from "./entry-panel";
import { RecipePicker, type PickableRecipe } from "./recipe-picker";

/**
 * The one screen that matters.
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
  activeTimeByRecipeId,
  dayLabels,
}: {
  week: IsoWeek;
  slots: readonly SlotDefinition[];
  entries: readonly PlanEntryView[];
  orphanedEntries: readonly PlanEntryView[];
  recipes: readonly PickableRecipe[];
  activeTimeByRecipeId: Readonly<Record<string, number | null>>;
  /** Formatted on the server so date formatting has one implementation. */
  dayLabels: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("week");
  const days = useTranslations("week.days");
  const common = useTranslations("common");
  const router = useRouter();

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
    useSensor(KeyboardSensor),
  );

  async function run(
    action: () => Promise<ActionResult<WriteResult>>,
  ): Promise<void> {
    setPending(true);
    const result = await action();
    setPending(false);

    if (!result.ok) {
      setFeedback({ error: { code: result.code, message: result.message } });
      return;
    }

    setEntries(result.data.entries);
    setFeedback({ warnings: result.data.warnings as DomainWarning[] });
    setPickerSlot(null);
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

  const plannedSlots = slots.filter((slot) => slot.state !== "hidden");

  if (plannedSlots.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm opacity-70">{t("noPlannedSlots")}</p>
        <a href="/creneaux" className="text-sm underline">
          {t("configureSlots")}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Feedback {...feedback} />
      <p className="text-xs opacity-60">{t("dragHint")}</p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-3 md:grid-cols-7">
          {ISO_DAYS.map((day) => {
            const daySlots = plannedSlots.filter(
              (slot) => slot.dayOfWeek === day,
            );
            if (daySlots.length === 0) return null;

            const dayMinutes = entries.reduce((total, entry) => {
              if (entry.dayOfWeek !== day || entry.recipeId === null) {
                return total;
              }
              return total + (activeTimeByRecipeId[entry.recipeId] ?? 0);
            }, 0);

            return (
              <section key={day} className="flex flex-col gap-2">
                <header className="flex flex-col">
                  <h2 className="text-sm font-semibold">
                    {days(String(day))}
                  </h2>
                  <span className="text-xs opacity-60">
                    {dayLabels[String(day)]}
                  </span>
                  {dayMinutes > 0 ? (
                    <span className="text-xs opacity-60">
                      {t("activeTime", { count: dayMinutes })}
                    </span>
                  ) : null}
                </header>

                {daySlots.map((slot) => {
                  const key = slotKey(slot.dayOfWeek, slot.mealTypeId);
                  const slotEntries = entries
                    .filter(
                      (entry) =>
                        entry.dayOfWeek === slot.dayOfWeek &&
                        entry.mealTypeId === slot.mealTypeId,
                    )
                    .sort((a, b) => a.position - b.position);

                  return (
                    <SlotCell
                      key={key}
                      slotId={key}
                      slot={slot}
                      disabled={slot.state !== "planned"}
                    >
                      <div className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-1">
                          <span className="text-xs font-medium opacity-70">
                            {slot.mealTypeLabel}
                          </span>
                          {slot.timeBudgetMin !== null ? (
                            <span className="text-[11px] opacity-50">
                              {t("budget", { count: slot.timeBudgetMin })}
                            </span>
                          ) : null}
                        </div>

                        {slot.state === "skipped" ? (
                          <span className="text-xs italic opacity-50">
                            {t("skippedSlot")}
                          </span>
                        ) : null}

                        {slotEntries.map((entry) => (
                          <EntryCard
                            key={entry.id}
                            entry={entry}
                            activeTimeMin={
                              entry.recipeId
                                ? (activeTimeByRecipeId[entry.recipeId] ?? null)
                                : null
                            }
                            onOpen={() => setOpenEntryId(entry.id)}
                          />
                        ))}

                        {slot.state === "planned" && slotEntries.length === 0 ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => setPickerSlot(key)}
                            className="rounded-md border border-dashed border-black/20 px-2 py-3 text-xs opacity-70 hover:opacity-100 disabled:opacity-40 dark:border-white/25"
                          >
                            {t("assign")}
                          </button>
                        ) : null}
                      </div>

                      {pickerSlot === key ? (
                        <div className="mt-2">
                          <RecipePicker
                            heading={`${days(String(slot.dayOfWeek))} ${slot.mealTypeLabel}`}
                            initialRecipes={recipes}
                            disabled={pending}
                            onClose={() => setPickerSlot(null)}
                            onPick={(recipeId) =>
                              void run(() =>
                                assignRecipeAction(week, {
                                  dayOfWeek: slot.dayOfWeek,
                                  mealTypeId: slot.mealTypeId,
                                  recipeId,
                                }),
                              )
                            }
                          />
                        </div>
                      ) : null}

                      {slotEntries.map((entry) =>
                        openEntryId === entry.id ? (
                          <div key={`panel-${entry.id}`} className="mt-2">
                            <EntryPanel
                              entry={entry}
                              slots={slots}
                              disabled={pending}
                              onClose={() => setOpenEntryId(null)}
                              onSave={(changes) =>
                                void run(() =>
                                  updateEntryAction(week, entry.id, changes),
                                )
                              }
                              onDuplicate={(target) =>
                                void run(() =>
                                  duplicateEntryAction(week, entry.id, target),
                                )
                              }
                              onClear={() =>
                                void run(() => clearEntryAction(week, entry.id))
                              }
                            />
                          </div>
                        ) : null,
                      )}
                    </SlotCell>
                  );
                })}
              </section>
            );
          })}
        </div>
      </DndContext>

      {orphanedEntries.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-md border border-amber-500/40 p-3">
          <h2 className="text-sm font-medium">{t("orphaned")}</h2>
          <p className="text-xs opacity-70">{t("orphanedHelp")}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {orphanedEntries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2">
                <span>
                  {days(String(entry.dayOfWeek))} · {entry.recipeTitleSnapshot}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void run(() => clearEntryAction(week, entry.id))}
                  className="text-xs underline disabled:opacity-50"
                >
                  {common("delete")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SlotCell({
  slotId,
  slot,
  disabled,
  children,
}: {
  slotId: string;
  slot: SlotDefinition;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: slotId, disabled });

  return (
    <div
      ref={setNodeRef}
      aria-label={`${slot.mealTypeLabel} ${slot.dayOfWeek}`}
      className={`rounded-md border p-2 transition-colors ${
        disabled
          ? "border-black/10 bg-black/5 opacity-60 dark:border-white/10 dark:bg-white/5"
          : isOver
            ? "border-black/40 bg-black/5 dark:border-white/50 dark:bg-white/10"
            : "border-black/15 dark:border-white/20"
      }`}
    >
      {children}
    </div>
  );
}

function EntryCard({
  entry,
  activeTimeMin,
  onOpen,
}: {
  entry: PlanEntryView;
  activeTimeMin: number | null;
  onOpen: () => void;
}) {
  const common = useTranslations("common");
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: entry.id });

  return (
    <div
      ref={setNodeRef}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      className={`flex flex-col gap-0.5 rounded-md border border-black/15 bg-white px-2 py-1.5 text-sm dark:border-white/20 dark:bg-neutral-900 ${
        isDragging ? "opacity-60 shadow-lg" : ""
      }`}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        onClick={onOpen}
        className="text-left font-medium underline-offset-2 hover:underline"
      >
        {entry.recipeTitleSnapshot}
      </button>
      <span className="text-xs opacity-60">
        {common("servings", { count: entry.servings })}
        {activeTimeMin !== null
          ? ` · ${common("minutes", { count: activeTimeMin })}`
          : ""}
      </span>
      {entry.note ? (
        <span className="text-xs italic opacity-70">{entry.note}</span>
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
