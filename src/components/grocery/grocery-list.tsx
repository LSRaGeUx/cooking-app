"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  addManualLineAction,
  archiveGroceryListAction,
  deleteLineAction,
  generateGroceryListAction,
  setLineCheckedAction,
} from "@/app/actions/grocery-actions";
import { EmptyState } from "@/components/empty-state";
import { Feedback } from "@/components/feedback";
import type { RenderableError } from "@/lib/error-message";
import { emptyToNull, formatQuantity, optionalNumber } from "@/lib/form-values";
import { sealClass } from "@/lib/recipe-seal";
import { useActionRunner } from "@/lib/use-action-runner";
import { useOfflineChecks, type FlushReport } from "@/lib/offline-queue";
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
 *
 * What the screen does *not* do any more is treat its own copy of the lines as
 * the truth. `list.lines` used to be copied into state at mount and never
 * resynchronised, so a list an agent regenerated over MCP, or one archived and
 * rebuilt, kept rendering the lines this component saw when it mounted, and the
 * `wasEmpty` check that decides whether to highlight a diff read that stale
 * copy. The server's lines are rendered directly, with the result of the last
 * local write kept as an overlay that a new server render discards.
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
  const locale = useLocale();
  const runner = useActionRunner();

  const serverLines = list?.lines ?? NO_LINES;

  /*
   * Local edits, held only until the server's own render arrives. Keyed by the
   * array they were derived from, so a refresh discards them in the same render
   * that brings the new lines in: no effect, and no frame showing the old list.
   */
  const [overlay, setOverlay] = useState<{
    readonly of: readonly GroceryLineView[];
    readonly lines: readonly GroceryLineView[];
  } | null>(null);
  const lines =
    overlay !== null && overlay.of === serverLines
      ? overlay.lines
      : serverLines;

  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Its own flag rather than a sentinel string in the set above. That
  // sentinel was a NUL character, which made every tool that reads this
  // file treat it as binary.
  const [optionalCollapsed, setOptionalCollapsed] = useState(false);
  const [diffSummary, setDiffSummary] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<RenderableError | null>(null);

  /** Replaces the overlay, always against the lines the server last sent. */
  const edit = useCallback(
    (
      change: (
        current: readonly GroceryLineView[],
      ) => readonly GroceryLineView[],
    ) => {
      setOverlay((previous) => ({
        of: serverLines,
        lines: change(
          previous !== null && previous.of === serverLines
            ? previous.lines
            : serverLines,
        ),
      }));
    },
    [serverLines],
  );

  /*
   * A replay of queued ticks can find out that the server refuses one. That
   * used to be swallowed, with a comment claiming the screen reloaded the
   * truth; nothing reloaded, so a tick simply vanished. The first refusal is
   * shown and the list is re-read.
   */
  const onReplay = useCallback((report: FlushReport) => {
    const [first] = report.refusals;
    if (first) setReplayError(first);
  }, []);

  const offline = useOfflineChecks(setLineCheckedAction, onReplay);

  // Staples are set aside rather than dropped. The one week you are out of
  // flour is the week a silently missing line ruins dinner, so they stay
  // visible in a collapsed section you can check.
  const covered = useMemo(
    () => lines.filter((line) => line.coveredByPantry),
    [lines],
  );
  // What the trip is actually for. Optional ingredients are shopped from a
  // section of their own: they are a decision made in front of the shelf, so
  // they sit outside the aisles and outside the count that says how much is
  // left, which would otherwise never reach the end.
  const toBuy = useMemo(
    () => lines.filter((line) => !line.coveredByPantry && !line.optional),
    [lines],
  );
  const optional = useMemo(
    () => lines.filter((line) => !line.coveredByPantry && line.optional),
    [lines],
  );
  const groups = useMemo(() => groupByAisle(toBuy, locale), [toBuy, locale]);
  const checkedCount = toBuy.filter((line) => line.checked).length;

  function regenerate(): void {
    // Highlighting is for a merge. On a first build every line is new, and
    // marking all of them says nothing while making the list hard to read.
    // Read from what is on screen now, which is the server's list plus any
    // local edit, rather than from a copy taken at mount.
    const wasEmpty = lines.length === 0;

    void runner.run(() => generateGroceryListAction(cycleStart), {
      onSuccess: (data) => {
        setChangedIds(wasEmpty ? new Set() : new Set(data.diff.changedLineIds));
        setDiffSummary(
          t("diff", {
            added: data.diff.added,
            updated: data.diff.updated,
            removed: data.diff.removed,
          }),
        );
        edit(() => data.list.lines);
      },
    });
  }

  async function toggle(line: GroceryLineView): Promise<void> {
    const next = !line.checked;
    edit((current) =>
      current.map((row) =>
        row.id === line.id ? { ...row, checked: next } : row,
      ),
    );

    const outcome = await offline.submit(line.id, next);
    // A queued tick stays on screen: it is going to be written. Only a refusal
    // from the server puts the box back where the server says it is.
    if (outcome.kind === "refused") {
      edit((current) =>
        current.map((row) =>
          row.id === line.id ? { ...row, checked: line.checked } : row,
        ),
      );
      setReplayError(outcome.error);
    }
  }

  function removeLine(lineId: string): void {
    void runner.run(() => deleteLineAction(cycleStart, lineId), {
      onSuccess: () =>
        edit((current) => current.filter((row) => row.id !== lineId)),
    });
  }

  function addLine(form: FormData): void {
    if (!list) return;
    const displayName = emptyToNull(form.get("displayName"));
    if (displayName === null) return;

    void runner.run(
      () =>
        addManualLineAction(cycleStart, list.id, {
          displayName,
          quantity: optionalNumber(form.get("quantity")),
          unit: emptyToNull(form.get("unit")),
          aisle: emptyToNull(form.get("aisle")),
        }),
      { onSuccess: (line) => edit((current) => [...current, line]) },
    );
  }

  const feedbackError = runner.feedback ?? replayError;

  if (!list) {
    return (
      <div className="page">
        <Feedback error={feedbackError} warnings={runner.warnings} />
        <EmptyState
          message={hasActivePlan ? t("empty") : t("noPlan")}
          {...(hasActivePlan
            ? {}
            : { action: { href: weekHref, label: t("goToWeek") } })}
        >
          {hasActivePlan ? (
            <button
              type="button"
              disabled={runner.pending}
              onClick={regenerate}
              className="btn btn-primary"
            >
              {runner.pending ? t("generating") : t("generate")}
            </button>
          ) : null}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Feedback error={feedbackError} warnings={runner.warnings} />

      {/*
        Said once, on the screen where it matters, with the one link that fixes
        it. Not a nag: it disappears the moment a shopping day is set.
      */}
      {!hasShoppingDay ? (
        <p className="band flex flex-wrap items-center gap-3 bg-panel px-5 py-3 lg:px-8">
          <span className="hint">{t("noShoppingDay")}</span>
          <Link href="/profil" className="btn btn-sm ml-auto">
            {t("setShoppingDay")}
          </Link>
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
              disabled={runner.pending}
              onClick={regenerate}
              className="btn btn-sm ml-auto"
            >
              {runner.pending ? t("generating") : t("regenerate")}
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
        <p className="band bg-panel px-5 py-2 lg:px-8" aria-live="polite">
          <span className="micro">{diffSummary}</span>
        </p>
      ) : null}

      {lines.length === 0 ? (
        <p className="hint">{t("emptyList")}</p>
      ) : (
        <div className="measure-wide flex flex-col border-x-2 border-rule">
          {groups.map((group) => {
            const key = group.aisle ?? "";
            const isCollapsed = collapsed.has(key);
            return (
              <section key={group.aisle ?? "__none"} className="flex flex-col">
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((current) => toggleIn(current, key))
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
                  {/* Said in words for a screen reader; aria-expanded alone
                      leaves the button reading as its own aisle name. */}
                  <span className="sr-only">
                    {isCollapsed ? t("expand") : t("collapse")}
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
                          disabled={runner.pending}
                          onToggle={() => void toggle(block.line)}
                          onRemove={() => removeLine(block.line.id)}
                        />
                      ) : (
                        <li key={block.group} className="py-1">
                          <p className="micro pt-1">{t("unmergeable")}</p>
                          <p className="hint">{t("unmergeableHelp")}</p>
                          <ul className="flex flex-col border-l-2 border-amber-line pl-3">
                            {block.lines.map((line) => (
                              <LineRow
                                key={line.id}
                                line={line}
                                sources={list.sources}
                                highlighted={changedIds.has(line.id)}
                                disabled={runner.pending}
                                onToggle={() => void toggle(line)}
                                onRemove={() => removeLine(line.id)}
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

          {/*
            Last, after every aisle, because it is the part of the list you read
            only once the shopping is done.
          */}
          {optional.length > 0 ? (
            <section className="flex flex-col">
              <button
                type="button"
                onClick={() => setOptionalCollapsed((closed) => !closed)}
                aria-expanded={!optionalCollapsed}
                className="flex w-full items-baseline justify-between gap-3 border-b-2 border-rule bg-panel px-5 py-2 text-left lg:px-8"
              >
                <span className="label-text">{t("optionalSection")}</span>
                <span className="label-text text-faint">
                  {optional.filter((line) => line.checked).length}/
                  {optional.length}
                </span>
                <span className="sr-only">
                  {optionalCollapsed ? t("expand") : t("collapse")}
                </span>
              </button>

              {optionalCollapsed ? null : (
                <ul className="flex flex-col">
                  {optional.map((line) => (
                    <LineRow
                      key={line.id}
                      line={line}
                      sources={list.sources}
                      highlighted={changedIds.has(line.id)}
                      disabled={runner.pending}
                      onToggle={() => void toggle(line)}
                      onRemove={() => removeLine(line.id)}
                    />
                  ))}
                </ul>
              )}
            </section>
          ) : null}
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
                {[formatQuantity(line.quantity, line.unit), line.displayName]
                  .filter((part) => part !== "")
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
        <h2 className="label-text w-full">{t("addLine")}</h2>
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
          <input name="quantity" inputMode="decimal" className="field" />
        </label>
        <label className="label w-20">
          <span>{t("addLineUnit")}</span>
          <input name="unit" className="field" />
        </label>
        <label className="label min-w-[8rem] flex-1">
          <span>{t("addLineAisle")}</span>
          <input name="aisle" className="field" />
        </label>
        <button
          type="submit"
          disabled={runner.pending}
          className="btn btn-quiet"
        >
          {common("add")}
        </button>
      </form>

      <button
        type="button"
        disabled={runner.pending}
        onClick={() =>
          void runner.run(() => archiveGroceryListAction(cycleStart, list.id))
        }
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
  const [firstDish] = dishes;
  const edge = firstDish
    ? sealClass(firstDish.recipeId ?? firstDish.entryId)
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
      <label className="flex flex-1 cursor-pointer items-center gap-3 py-4 pl-4 pr-4 lg:pl-8">
        <input
          type="checkbox"
          checked={line.checked}
          onChange={onToggle}
          className="shrink-0"
        />
        <span
          className={`name flex-1 text-[1.05rem] ${
            line.checked ? "text-faint line-through" : ""
          }`}
        >
          {[formatQuantity(line.quantity, line.unit), line.displayName]
            .filter((part) => part !== "")
            .join(" ")}
        </span>
        {line.useSoon ? (
          <span className="chip chip-warn shrink-0">{t("useSoonMark")}</span>
        ) : null}
        {/*
          Which meals a line is for, said in colour rather than in words. In a
          shop the line you are reading is the name of a thing to pick up, and
          a sentence naming two dishes under every one of thirty lines buries
          it. The names stay reachable: on the title for a pointer, and in full
          for a screen reader, which cannot see a square.
        */}
        {dishes.length > 0 ? (
          <span
            aria-hidden="true"
            title={meals.join(", ")}
            className="flex shrink-0 items-center gap-1"
          >
            {dishes.map((dish) => (
              <span
                key={dish.entryId}
                className={`${sealClass(dish.recipeId ?? dish.entryId)} seal-mark`}
              />
            ))}
          </span>
        ) : null}
        {meals.length > 0 ? (
          <span className="sr-only">
            {t("usedIn", { meals: meals.join(", ") })}
          </span>
        ) : null}
        {highlighted ? <span className="sr-only">{t("changed")}</span> : null}
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

/**
 * A stable empty array for a cycle that has no list yet. A fresh `[]` per
 * render would give the overlay a new key on every render, which discards a
 * local edit on the very next paint.
 */
const NO_LINES: readonly GroceryLineView[] = [];

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
 *
 * Sorted in the reader's locale, not in French. An aisle name is whatever the
 * cook typed, and collating "Épicerie" with French rules while the interface is
 * in English put it in a place an English reader would not look for it.
 */
function groupByAisle(
  lines: readonly GroceryLineView[],
  locale: string,
): AisleGroup[] {
  const byAisle = new Map<string, GroceryLineView[]>();
  for (const line of lines) {
    const key = line.aisle ?? "";
    const group = byAisle.get(key) ?? [];
    group.push(line);
    byAisle.set(key, group);
  }

  const collator = new Intl.Collator(locale);

  return [...byAisle.entries()]
    .sort(([a], [b]) => {
      // "No aisle" last, whatever the collation says about the empty string.
      if (a === "") return 1;
      if (b === "") return -1;
      return collator.compare(a, b);
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
