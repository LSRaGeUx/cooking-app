"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  addManualLineAction,
  archiveGroceryListAction,
  deleteLineAction,
  generateGroceryListAction,
  setLineCheckedAction,
} from "@/app/actions/grocery-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import { pluralizeUnit } from "@/domain/units";
import { sealClass } from "@/lib/recipe-seal";
import { useOfflineChecks } from "@/lib/offline-queue";
import type {
  GroceryEntrySource,
  GroceryLineView,
  GroceryListView,
} from "@/services/grocery-service";

/**
 * The shopping screen. Mobile is the primary viewport: it is used one-handed,
 * in a shop, on a bad connection.
 *
 * That shapes three decisions. Ticking a line updates local state immediately
 * and writes in the background, because a checkbox that waits for a round trip
 * is unusable while walking. A tick that cannot reach the server is queued and
 * replayed rather than reverted, so a dead spot in the shop does not undo the
 * shopping. And the regenerate button is deliberately explicit rather than
 * automatic: the list is a snapshot the user is working from, and rearranging it
 * under them without being asked is the one thing this screen must never do.
 */
export function GroceryList({
  cycleStart,
  list,
  hasActivePlan,
  weekHref,
  hasShoppingDay,
}: {
  /** The `yyyy-mm-dd` the shopping cycle begins on: the list's identity. */
  cycleStart: string;
  list: GroceryListView | null;
  hasActivePlan: boolean;
  weekHref: string;
  /** False while the cycle is still falling back to a Monday-to-Sunday week. */
  hasShoppingDay: boolean;
}) {
  const t = useTranslations("grocery");
  const common = useTranslations("common");
  const router = useRouter();

  const [lines, setLines] = useState<readonly GroceryLineView[]>(
    list?.lines ?? [],
  );
  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);
  const [diffSummary, setDiffSummary] = useState<string | null>(null);
  const offline = useOfflineChecks(setLineCheckedAction);

  // Staples are set aside rather than dropped. The one week you are out of
  // flour is the week a silently missing line ruins dinner, so they stay
  // visible in a collapsed section you can check.
  const toBuy = useMemo(
    () => lines.filter((line) => !line.coveredByPantry),
    [lines],
  );
  const covered = useMemo(
    () => lines.filter((line) => line.coveredByPantry),
    [lines],
  );
  const groups = useMemo(() => groupByAisle(toBuy), [toBuy]);
  const checkedCount = toBuy.filter((line) => line.checked).length;

  async function regenerate(): Promise<void> {
    // Highlighting is for a merge. On a first build every line is new, and
    // marking all of them says nothing while making the list hard to read.
    const wasEmpty = lines.length === 0;
    setPending(true);
    const result = await generateGroceryListAction(cycleStart);
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

    setFeedback({});
    setLines(result.data.list.lines);
    setChangedIds(wasEmpty ? new Set() : new Set(result.data.diff.changedLineIds));
    setDiffSummary(
      t("diff", {
        added: result.data.diff.added,
        updated: result.data.diff.updated,
        removed: result.data.diff.removed,
      }),
    );
    router.refresh();
  }

  async function toggle(line: GroceryLineView): Promise<void> {
    const next = !line.checked;
    setLines((current) =>
      current.map((row) => (row.id === line.id ? { ...row, checked: next } : row)),
    );

    const outcome = await offline.submit(line.id, next);
    // A queued tick stays on screen: it is going to be written. Only a refusal
    // from the server puts the box back where the server says it is.
    if (outcome.kind === "refused") {
      setLines((current) =>
        current.map((row) =>
          row.id === line.id ? { ...row, checked: line.checked } : row,
        ),
      );
      setFeedback({ error: outcome.error });
    }
  }

  async function removeLine(lineId: string): Promise<void> {
    setPending(true);
    const result = await deleteLineAction(cycleStart, lineId);
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
    setLines((current) => current.filter((row) => row.id !== lineId));
  }

  async function addLine(form: FormData): Promise<void> {
    if (!list) return;
    const displayName = String(form.get("displayName") ?? "").trim();
    if (displayName.length === 0) return;

    setPending(true);
    const result = await addManualLineAction(cycleStart, list.id, {
      displayName,
      quantity: optionalNumber(String(form.get("quantity") ?? "")),
      unit: emptyToNull(String(form.get("unit") ?? "")),
      aisle: emptyToNull(String(form.get("aisle") ?? "")),
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
    setLines((current) => [...current, result.data]);
    setFeedback({});
  }

  if (!list) {
    return (
      <div className="flex flex-col items-start gap-5 rounded-[3px] border border-dashed border-rule-strong bg-surface/40 px-8 py-14">
        <Feedback {...feedback} />
        <p className="display max-w-[24ch] text-[clamp(1.6rem,3vw,2.4rem)] leading-tight">
          {hasActivePlan ? t("empty") : t("noPlan")}
        </p>
        {hasActivePlan ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void regenerate()}
            className="btn btn-primary"
          >
            {pending ? t("generating") : t("generate")}
          </button>
        ) : (
          <a href={weekHref} className="btn btn-quiet">
            {t("goToWeek")}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Feedback {...feedback} />

      {/*
        Said once, on the screen where it matters, with the one link that fixes
        it. Not a nag: it disappears the moment a shopping day is set.
      */}
      {!hasShoppingDay ? (
        <p className="band flex flex-wrap items-center gap-3 bg-panel px-5 py-3 lg:px-8">
          <span className="hint">{t("noShoppingDay")}</span>
          <a href="/profil" className="btn btn-sm ml-auto">
            {t("setShoppingDay")}
          </a>
        </p>
      ) : null}

      {list.state === "draft" ? (
        <p className="banner banner-warn">{t("draft")}</p>
      ) : null}

      {list.stale ? <p className="banner banner-warn">{t("stale")}</p> : null}

      {!offline.online || offline.pendingCount > 0 ? (
        <p role="status" className="banner">
          {offline.pendingCount > 0
            ? t("queued", { count: offline.pendingCount })
            : t("offline")}
        </p>
      ) : null}

      {/*
        Sticky, because this is the one figure you look at while walking: how
        much of the list is left. A bar across the whole width, not a widget:
        it is the only thing on this screen that moves, so it gets the width.
      */}
      <div className="sticky top-0 z-20 bg-ground">
        <div className="measure-wide border-x-2 border-b-2 border-rule bg-panel">
          <div className="flex items-end gap-4 px-5 py-3 lg:px-8">
          <span aria-hidden="true" className="numeral text-4xl">
            {checkedCount}
            <span className="text-faint">/{toBuy.length}</span>
          </span>
          <span className="sr-only">
            {t("progress", { checked: checkedCount, total: toBuy.length })}
          </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => void regenerate()}
              className="btn btn-sm ml-auto"
            >
              {pending ? t("generating") : t("regenerate")}
            </button>
          </div>
          <div aria-hidden="true" className="h-2 w-full border-t-2 border-rule">
            <div
              className="h-full bg-tomato transition-[width] duration-200"
              style={{
                width: `${toBuy.length === 0 ? 0 : (checkedCount / toBuy.length) * 100}%`,
              }}
            />
          </div>
        </div>
      </div>

      {diffSummary ? (
        <p
          className="band bg-panel px-5 py-2 lg:px-8"
          aria-live="polite"
        >
          <span className="micro">{diffSummary}</span>
        </p>
      ) : null}

      {lines.length === 0 ? (
        <p className="hint">{t("emptyList")}</p>
      ) : (
        <div className="measure-wide flex flex-col border-x-2 border-rule">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.aisle ?? "");
            return (
              <section key={group.aisle ?? "__none"} className="flex flex-col">
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((current) => toggleIn(current, group.aisle ?? ""))
                  }
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-baseline justify-between gap-3 border-b-2 border-rule bg-ink px-5 py-2 text-left text-on-ink lg:px-8"
                >
                  <span className="label-text">
                    {group.aisle ?? t("noAisle")}
                  </span>
                  <span className="label-text opacity-70">
                    {group.lines.filter((line) => line.checked).length}/
                    {group.lines.length}
                  </span>
                </button>

                {isCollapsed ? null : (
                  <ul className="flex flex-col">
                    {group.blocks.map((block) =>
                      block.kind === "single" ? (
                        <LineRow
                          key={block.line.id}
                          line={block.line}
                          sources={list.sources}
                          highlighted={changedIds.has(block.line.id)}
                          disabled={pending}
                          onToggle={() => void toggle(block.line)}
                          onRemove={() => void removeLine(block.line.id)}
                        />
                      ) : (
                        <li key={block.group} className="py-1">
                          <p className="micro pt-1">{t("unmergeable")}</p>
                          <ul className="flex flex-col border-l-2 border-amber-line pl-3">
                            {block.lines.map((line) => (
                              <LineRow
                                key={line.id}
                                line={line}
                                sources={list.sources}
                                highlighted={changedIds.has(line.id)}
                                disabled={pending}
                                onToggle={() => void toggle(line)}
                                onRemove={() => void removeLine(line.id)}
                              />
                            ))}
                          </ul>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {covered.length > 0 ? (
        <details className="measure-wide slip my-5 px-4 py-3">
          <summary className="eyebrow cursor-pointer text-ink">
            {t("alreadyHave")} ({covered.length})
          </summary>
          <p className="hint pt-2">{t("alreadyHaveHelp")}</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-3">
            {covered.map((line) => (
              <li key={line.id} className="text-sm text-muted line-through">
                {[
                  line.quantity !== null ? formatQuantity(line.quantity) : null,
                  pluralizeUnit(line.unit, line.quantity),
                  line.displayName,
                ]
                  .filter((part) => part !== null && part !== "")
                  .join(" ")}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <form
        action={addLine}
        className="measure-wide flex flex-wrap items-end gap-3 border-x-2 border-b-2 border-rule bg-panel px-5 py-5 lg:px-8"
      >
        <label className="label min-w-[10rem] flex-1">
          <span>{t("addLineName")}</span>
          <input
            name="displayName"
            required
            placeholder={t("addLineNamePlaceholder")}
            className="field"
          />
        </label>
        <label className="label w-20">
          <span>{t("addLineQuantity")}</span>
          <input
            name="quantity"
            inputMode="decimal"
            className="field"
          />
        </label>
        <label className="label w-20">
          <span>{t("addLineUnit")}</span>
          <input
            name="unit"
            className="field"
          />
        </label>
        <label className="label min-w-[8rem] flex-1">
          <span>{t("addLineAisle")}</span>
          <input
            name="aisle"
            className="field"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="btn btn-quiet"
        >
          {common("add")}
        </button>
      </form>

      <button
        type="button"
        disabled={pending}
        onClick={() => {
          void archiveGroceryListAction(cycleStart, list.id).then(() =>
            router.refresh(),
          );
        }}
        className="btn btn-ghost btn-sm m-5 self-start lg:mx-8"
      >
        {t("archive")}
      </button>
    </div>
  );
}

function LineRow({
  line,
  sources,
  highlighted,
  disabled,
  onToggle,
  onRemove,
}: {
  line: GroceryLineView;
  sources: readonly GroceryEntrySource[];
  highlighted: boolean;
  disabled: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations("grocery");
  // The dishes this line is for, each keeping the colour it wears in the week.
  const dishes = sources.filter((source) =>
    line.sourceEntryIds.includes(source.entryId),
  );
  const meals = dishes.map((source) => source.title);
  const edge = dishes[0]
    ? sealClass(dishes[0].recipeId ?? dishes[0].entryId)
    : "";

  return (
    <li
      className={`${edge} flex items-stretch border-b-2 border-rule ${
        highlighted ? "bg-yellow text-ink" : ""
      } ${line.checked ? "bg-sunk" : ""}`}
    >
      {/* The colour of the dish this is for, read before the words are. */}
      <span
        aria-hidden="true"
        className="w-3 shrink-0 border-r-2 border-rule bg-seal"
      />
      {/* A large hit area: this is tapped with a thumb while holding a basket. */}
      <label className="flex flex-1 cursor-pointer items-start gap-4 py-4 pl-4 lg:pl-8">
        <input type="checkbox" checked={line.checked} onChange={onToggle} />
        <span className="flex flex-col gap-0.5">
          <span
            className={`name text-[1.05rem] ${
              line.checked ? "text-faint line-through" : ""
            }`}
          >
            {[
              line.quantity !== null ? formatQuantity(line.quantity) : null,
              pluralizeUnit(line.unit, line.quantity),
              line.displayName,
            ]
              .filter((part) => part !== null && part !== "")
              .join(" ")}
          </span>
          {line.useSoon ? (
            <span className="chip chip-warn self-start">{t("useSoonMark")}</span>
          ) : null}
          {meals.length > 0 ? (
            <span className="flex items-center gap-1.5">
              {dishes.map((dish) => (
                <span
                  key={dish.entryId}
                  aria-hidden="true"
                  className={`${sealClass(dish.recipeId ?? dish.entryId)} seal-mark`}
                />
              ))}
              <span className="micro">
                {t("usedIn", { meals: meals.join(", ") })}
              </span>
            </span>
          ) : null}
          {line.origin === "manual" ? (
            <span className="micro">{t("manual")}</span>
          ) : null}
          {highlighted ? (
            <span className="micro text-amber-ink">{t("changed")}</span>
          ) : null}
        </span>
      </label>

      <button
        type="button"
        disabled={disabled}
        aria-label={t("removeLine")}
        onClick={onRemove}
        className="fillable shrink-0 border-l-2 border-rule px-4 text-faint disabled:opacity-30"
      >
        &times;
      </button>
    </li>
  );
}

type Block =
  | { kind: "single"; line: GroceryLineView }
  | { kind: "group"; group: string; lines: GroceryLineView[] };

interface AisleGroup {
  readonly aisle: string | null;
  readonly lines: GroceryLineView[];
  readonly blocks: Block[];
}

/**
 * Aisle sections, with the lines of one unmergeable ingredient kept adjacent
 * under a single heading so the two halves of "2 oignons / 300 g d'oignons"
 * cannot drift apart in the list.
 */
function groupByAisle(lines: readonly GroceryLineView[]): AisleGroup[] {
  const byAisle = new Map<string, GroceryLineView[]>();
  for (const line of lines) {
    const key = line.aisle ?? "";
    const group = byAisle.get(key) ?? [];
    group.push(line);
    byAisle.set(key, group);
  }

  return [...byAisle.entries()]
    .sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b, "fr");
    })
    .map(([aisle, group]) => {
      const blocks: Block[] = [];
      const seenGroups = new Set<string>();

      for (const line of group) {
        if (line.unmergeableGroup === null) {
          blocks.push({ kind: "single", line });
          continue;
        }
        if (seenGroups.has(line.unmergeableGroup)) continue;
        seenGroups.add(line.unmergeableGroup);
        blocks.push({
          kind: "group",
          group: line.unmergeableGroup,
          lines: group.filter(
            (row) => row.unmergeableGroup === line.unmergeableGroup,
          ),
        });
      }

      return { aisle: aisle === "" ? null : aisle, lines: group, blocks };
    });
}

function toggleIn(
  current: ReadonlySet<string>,
  value: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity)
    ? String(quantity)
    : String(Number(quantity.toFixed(2)));
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
