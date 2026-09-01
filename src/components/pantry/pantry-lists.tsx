"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  addPantryItemsAction,
  removePantryItemAction,
} from "@/app/actions/pantry-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
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
  const router = useRouter();

  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);

  async function run(
    action: () => Promise<{ ok: boolean; code?: string; message?: string }>,
  ): Promise<boolean> {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: { code: result.code ?? "INTERNAL", message: result.message ?? "" },
      });
      return false;
    }
    setFeedback({});
    router.refresh();
    return true;
  }

  return (
    <div className="flex flex-col gap-8">
      <Feedback {...feedback} />

      <PantrySection
        kind="use_soon"
        title={t("useSoon")}
        help={t("useSoonHelp")}
        addLabel={t("addUseSoon")}
        withExpiry
        items={items.filter((item) => item.kind === "use_soon")}
        disabled={pending}
        onRun={run}
      />

      <PantrySection
        kind="staple"
        title={t("staples")}
        help={t("staplesHelp")}
        addLabel={t("addStaple")}
        withExpiry={false}
        items={items.filter((item) => item.kind === "staple")}
        disabled={pending}
        onRun={run}
      />

      <p className="sr-only" aria-live="polite">
        {pending ? common("saving") : ""}
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
  disabled,
  onRun,
}: {
  kind: "staple" | "use_soon";
  title: string;
  help: string;
  addLabel: string;
  withExpiry: boolean;
  items: readonly PantryItemView[];
  disabled: boolean;
  onRun: (
    action: () => Promise<{ ok: boolean; code?: string; message?: string }>,
  ) => Promise<boolean>;
}) {
  const t = useTranslations("pantry");
  const common = useTranslations("common");

  const [name, setName] = useState("");
  const [quantityNote, setQuantityNote] = useState("");
  const [expiresOn, setExpiresOn] = useState("");

  const field =
    "rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {title}
        </h2>
        <p className="max-w-2xl text-xs opacity-70">{help}</p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm opacity-70">{t("empty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-md border border-black/15 px-2 py-1 text-sm dark:border-white/20"
            >
              <span>{item.name}</span>
              {item.quantityNote ? (
                <span className="text-xs opacity-60">{item.quantityNote}</span>
              ) : null}
              {item.expiresOn ? (
                <span className="text-xs opacity-60">
                  {t("expires", { date: item.expiresOn })}
                </span>
              ) : null}
              {item.source === "agent" ? (
                <span className="text-xs opacity-50">{t("addedByAgent")}</span>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                aria-label={common("delete")}
                onClick={() => void onRun(() => removePantryItemAction(item.id))}
                className="text-xs opacity-50 hover:opacity-100 disabled:opacity-30"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">{t("name")}</span>
          <input
            value={name}
            placeholder={t("namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
            className={`w-full ${field}`}
          />
        </label>
        <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">{t("quantityNote")}</span>
          <input
            value={quantityNote}
            placeholder={t("quantityNotePlaceholder")}
            onChange={(event) => setQuantityNote(event.target.value)}
            className={`w-full ${field}`}
          />
        </label>
        {withExpiry ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("expiresOn")}</span>
            <input
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
              className={field}
            />
          </label>
        ) : null}
        <button
          type="button"
          disabled={disabled || name.trim().length === 0}
          onClick={async () => {
            const ok = await onRun(() =>
              addPantryItemsAction([
                {
                  kind,
                  name: name.trim(),
                  quantityNote: quantityNote.trim() || null,
                  expiresOn: withExpiry && expiresOn ? expiresOn : null,
                },
              ]),
            );
            if (ok) {
              setName("");
              setQuantityNote("");
              setExpiresOn("");
            }
          }}
          className="rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
        >
          {addLabel}
        </button>
      </div>

      {!withExpiry ? (
        <p className="text-xs opacity-70">{t("quantityNoteHelp")}</p>
      ) : null}
    </section>
  );
}
