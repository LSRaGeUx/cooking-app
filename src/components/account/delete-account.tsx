"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { deleteAccountAction } from "@/app/actions/account-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";

/**
 * Deleting the account, behind a typed confirmation.
 *
 * A typed word rather than a second button: this is the one action in the
 * product with no undo, and the friction is the point.
 */
export function DeleteAccount() {
  const t = useTranslations("account");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>({});

  return (
    <section className="flex flex-col gap-2 rounded-md border border-red-500/40 p-3">
      <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
        {t("delete")}
      </h2>
      <p className="max-w-2xl text-xs opacity-70">{t("deleteHelp")}</p>
      <Feedback {...feedback} />

      <label className="flex max-w-sm flex-col gap-1 text-sm">
        <span className="font-medium">{t("deleteConfirmLabel")}</span>
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
        />
      </label>

      <button
        type="button"
        disabled={
          pending ||
          confirmation.trim().toUpperCase() !== t("deleteConfirmWord")
        }
        onClick={async () => {
          setPending(true);
          const result = await deleteAccountAction(confirmation);
          setPending(false);
          if (result && !result.ok) {
            setFeedback({
              error: { code: result.code, message: result.message },
            });
          }
        }}
        className="self-start rounded-md border border-red-500/50 px-3 py-2 text-sm text-red-700 disabled:opacity-40 dark:text-red-400"
      >
        {pending ? t("deleting") : t("deleteSubmit")}
      </button>
    </section>
  );
}
