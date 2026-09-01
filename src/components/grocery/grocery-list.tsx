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
import type { IsoWeek } from "@/domain/week";
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
  week,
  list,
  hasActivePlan,
  weekHref,
}: {
  week: IsoWeek;
  list: GroceryListView | null;
  hasActivePlan: boolean;
  weekHref: string;
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
    setPending(true);
    const result = await generateGroceryListAction(week);
    setPending(false);

    if (!result.ok) {
      setFeedback({ error: { code: result.code, message: result.message } });
      return;
    }

    setFeedback({});
    setLines(result.data.list.lines);
    setChangedIds(new Set(result.data.diff.changedLineIds));
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
    if (outcome === "refused") {
      setLines((current) =>
        current.map((row) =>
          row.id === line.id ? { ...row, checked: line.checked } : row,
        ),
      );
      setFeedback({
        error: { code: "CONFLICT", message: t("checkFailed") },
      });
    }
  }

  async function removeLine(lineId: string): Promise<void> {
    setPending(true);
    const result = await deleteLineAction(week, lineId);
    setPending(false);
    if (!result.ok) {
      setFeedback({ error: { code: result.code, message: result.message } });
      return;
    }
    setLines((current) => current.filter((row) => row.id !== lineId));
  }

  async function addLine(form: FormData): Promise<void> {
    if (!list) return;
    const displayName = String(form.get("displayName") ?? "").trim();
    if (displayName.length === 0) return;

    setPending(true);
    const result = await addManualLineAction(week, list.id, {
      displayName,
      quantity: optionalNumber(String(form.get("quantity") ?? "")),
      unit: emptyToNull(String(form.get("unit") ?? "")),
      aisle: emptyToNull(String(form.get("aisle") ?? "")),
    });
    setPending(false);

    if (!result.ok) {
      setFeedback({ error: { code: result.code, message: result.message } });
      return;
    }
    setLines((current) => [...current, result.data]);
    setFeedback({});
  }

  if (!list) {
    return (
      <div className="flex flex-col gap-3">
        <Feedback {...feedback} />
        <p className="text-sm opacity-70">
          {hasActivePlan ? t("empty") : t("noPlan")}
        </p>
        {hasActivePlan ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void regenerate()}
            className="self-start rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {pending ? t("generating") : t("generate")}
          </button>
        ) : (
          <a href={weekHref} className="self-start text-sm underline">
            {t("goToWeek")}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Feedback {...feedback} />

      {list.state === "draft" ? (
        <p className="rounded-md border border-amber-500/40 px-3 py-2 text-sm">
          {t("draft")}
        </p>
      ) : null}

      {list.stale ? (
        <p className="rounded-md border border-amber-500/40 px-3 py-2 text-sm">
          {t("stale")}
        </p>
      ) : null}

      {!offline.online || offline.pendingCount > 0 ? (
        <p
          role="status"
          className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
        >
          {offline.pendingCount > 0
            ? t("queued", { count: offline.pendingCount })
            : t("offline")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm opacity-70">
          {t("progress", { checked: checkedCount, total: toBuy.length })}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => void regenerate()}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/20"
        >
          {pending ? t("generating") : t("regenerate")}
        </button>
      </div>

      {diffSummary ? (
        <p className="text-xs opacity-70" aria-live="polite">
          {diffSummary}
        </p>
      ) : null}

      {lines.length === 0 ? (
        <p className="text-sm opacity-70">{t("emptyList")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.aisle ?? "");
            return (
              <section key={group.aisle ?? "__none"} className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((current) => toggleIn(current, group.aisle ?? ""))
                  }
                  aria-expanded={!isCollapsed}
                  className="flex items-baseline justify-between border-b border-black/10 pb-1 text-left text-sm font-medium dark:border-white/15"
                >
                  <span>{group.aisle ?? t("noAisle")}</span>
                  <span className="text-xs font-normal opacity-60">
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
                          <p className="text-xs opacity-60">{t("unmergeable")}</p>
                          <ul className="flex flex-col border-l border-black/15 pl-2 dark:border-white/20">
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
        <details className="rounded-md border border-black/10 px-3 py-2 dark:border-white/15">
          <summary className="cursor-pointer text-sm">
            {t("alreadyHave")} ({covered.length})
          </summary>
          <p className="pt-2 text-xs opacity-70">{t("alreadyHaveHelp")}</p>
          <ul className="flex flex-wrap gap-2 pt-2">
            {covered.map((line) => (
              <li key={line.id} className="text-sm opacity-70">
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
        className="flex flex-wrap items-end gap-2 border-t border-black/10 pt-4 dark:border-white/15"
      >
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">{t("addLineName")}</span>
          <input
            name="displayName"
            required
            placeholder={t("addLineNamePlaceholder")}
            className="w-full rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
          />
        </label>
        <label className="flex w-20 flex-col gap-1 text-sm">
          <span className="font-medium">{t("addLineQuantity")}</span>
          <input
            name="quantity"
            inputMode="decimal"
            className="w-full rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
          />
        </label>
        <label className="flex w-20 flex-col gap-1 text-sm">
          <span className="font-medium">{t("addLineUnit")}</span>
          <input
            name="unit"
            className="w-full rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
          />
        </label>
        <label className="flex min-w-[8rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">{t("addLineAisle")}</span>
          <input
            name="aisle"
            className="w-full rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
        >
          {common("add")}
        </button>
      </form>

      <button
        type="button"
        disabled={pending}
        onClick={() => {
          void archiveGroceryListAction(week, list.id).then(() =>
            router.refresh(),
          );
        }}
        className="self-start text-xs underline opacity-60 disabled:opacity-40"
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
  const meals = sources
    .filter((source) => line.sourceEntryIds.includes(source.entryId))
    .map((source) => source.title);

  return (
    <li
      className={`flex items-start gap-3 border-b border-black/5 py-2 dark:border-white/10 ${
        highlighted ? "bg-amber-500/10" : ""
      }`}
    >
      {/* A large hit area: this is tapped with a thumb while holding a basket. */}
      <label className="flex flex-1 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={line.checked}
          onChange={onToggle}
          className="mt-0.5 h-5 w-5 shrink-0"
        />
        <span className="flex flex-col">
          <span className={line.checked ? "line-through opacity-50" : ""}>
            {[
              line.quantity !== null ? formatQuantity(line.quantity) : null,
              pluralizeUnit(line.unit, line.quantity),
              line.displayName,
            ]
              .filter((part) => part !== null && part !== "")
              .join(" ")}
          </span>
          {line.useSoon ? (
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {t("useSoonMark")}
            </span>
          ) : null}
          {meals.length > 0 ? (
            <span className="text-xs opacity-50">
              {t("usedIn", { meals: meals.join(", ") })}
            </span>
          ) : null}
          {line.origin === "manual" ? (
            <span className="text-xs opacity-50">{t("manual")}</span>
          ) : null}
          {highlighted ? (
            <span className="text-xs opacity-70">{t("changed")}</span>
          ) : null}
        </span>
      </label>

      <button
        type="button"
        disabled={disabled}
        aria-label={t("removeLine")}
        onClick={onRemove}
        className="shrink-0 px-2 text-xs opacity-50 hover:opacity-100 disabled:opacity-30"
      >
        ×
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
