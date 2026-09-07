"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  addPantryItemsAction,
  removePantryItemAction,
} from "@/app/actions/pantry-actions";
import { Feedback } from "@/components/feedback";
import type { PantryKind } from "@/domain/vocabulary";
import { useActionRunner, type ActionRunner } from "@/lib/use-action-runner";
import type { PantryItemView } from "@/services/pantry-service";

/**
 * Two lists, and nothing that looks like inventory software.
 *
 * There is no quantity field that takes a number, no "consumed" button, and
 * nothing to reconcile. Every one of those would be a small improvement that
 * together make the feature a chore, and a pantry nobody updates is worse than
 * no pantry at all.
 */
export function PantryLists({ items }: { items: readonly PantryItemView[] }) {
  const t = useTranslations("pantry");
  const common = useTranslations("common");
  const runner = useActionRunner();

  return (
    <div className="flex flex-col gap-8">
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      <PantrySection
        kind="use_soon"
        title={t("useSoon")}
        help={t("useSoonHelp")}
        addLabel={t("addUseSoon")}
        withExpiry
        items={items.filter((item) => item.kind === "use_soon")}
        runner={runner}
      />

      <PantrySection
        kind="staple"
        title={t("staples")}
        help={t("staplesHelp")}
        addLabel={t("addStaple")}
        withExpiry={false}
        items={items.filter((item) => item.kind === "staple")}
        runner={runner}
      />

      <p className="sr-only" aria-live="polite">
        {runner.pending ? common("saving") : ""}
      </p>
    </div>
  );
}

function PantrySection({
  kind,
  title,
  help,
  addLabel,
  withExpiry,
  items,
  runner,
}: {
  kind: PantryKind;
  title: string;
  help: string;
  addLabel: string;
  withExpiry: boolean;
  items: readonly PantryItemView[];
  runner: ActionRunner;
}) {
  const t = useTranslations("pantry");
  const common = useTranslations("common");
  const format = useFormatter();

  const [name, setName] = useState("");
  const [quantityNote, setQuantityNote] = useState("");
  const [expiresOn, setExpiresOn] = useState("");

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="eyebrow eyebrow-rule">{title}</h2>
        <p className="hint">{help}</p>
      </div>

      {items.length === 0 ? (
        <p className="hint">{t("empty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={`slip flex items-center gap-2 border-l-[3px] py-1.5 pl-2.5 pr-1 text-sm ${
                kind === "use_soon" ? "border-l-amber-ink" : "border-l-olive"
              }`}
            >
              <span>{item.name}</span>
              {item.quantityNote ? (
                <span className="micro">{item.quantityNote}</span>
              ) : null}
              {item.expiresOn ? (
                <span className="micro text-amber-ink">
                  {/*
                    Formatted, not printed. This was showing the raw
                    `yyyy-mm-dd` the column stores, which is the one date
                    format nobody reads a use-by date in.
                  */}
                  {t("expires", { date: formatDate(format, item.expiresOn) })}
                </span>
              ) : null}
              {item.source === "agent" ? (
                <span className="chip chip-agent">{t("addedByAgent")}</span>
              ) : null}
              <button
                type="button"
                disabled={runner.pending}
                aria-label={common("delete")}
                onClick={() =>
                  void runner.run(() => removePantryItemAction(item.id))
                }
                className="px-1.5 text-faint transition-colors hover:text-danger-ink disabled:opacity-30"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="label min-w-[10rem] flex-1">
          <span>{t("name")}</span>
          <input
            value={name}
            placeholder={t("namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
            className="field"
          />
        </label>
        <label className="label min-w-[10rem] flex-1">
          <span>{t("quantityNote")}</span>
          <input
            value={quantityNote}
            placeholder={t("quantityNotePlaceholder")}
            onChange={(event) => setQuantityNote(event.target.value)}
            className="field"
          />
        </label>
        {withExpiry ? (
          <label className="label">
            <span>{t("expiresOn")}</span>
            <input
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
              className="field"
            />
          </label>
        ) : null}
        <button
          type="button"
          disabled={runner.pending || name.trim().length === 0}
          onClick={() =>
            void runner
              .run(() =>
                addPantryItemsAction([
                  {
                    kind,
                    name: name.trim(),
                    quantityNote: quantityNote.trim() || null,
                    expiresOn: withExpiry && expiresOn ? expiresOn : null,
                  },
                ]),
              )
              .then((result) => {
                if (!result?.ok) return;
                setName("");
                setQuantityNote("");
                setExpiresOn("");
              })
          }
          className="btn btn-quiet"
        >
          {addLabel}
        </button>
      </div>

      {!withExpiry ? <p className="hint">{t("quantityNoteHelp")}</p> : null}
    </section>
  );
}

/**
 * A stored `yyyy-mm-dd` as a date the reader recognises.
 *
 * Parsed as UTC midnight and formatted in UTC, because the column is a calendar
 * day and not an instant: parsing it in the browser's zone puts a use-by date
 * one day earlier for anyone west of Greenwich.
 */
function formatDate(
  format: ReturnType<typeof useFormatter>,
  isoDate: string,
): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return format.dateTime(parsed, { dateStyle: "medium", timeZone: "UTC" });
}
