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
    <section className="flex flex-col gap-3 rounded-[3px] border border-danger-line border-l-[3px] border-l-danger bg-danger-soft p-5">
      <h2 className="eyebrow text-danger-ink">{t("delete")}</h2>
      <p className="hint">{t("deleteHelp")}</p>
      <Feedback {...feedback} />

      <label className="label max-w-sm">
        <span>{t("deleteConfirmLabel")}</span>
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className="field font-mono tracking-[0.2em]"
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
              error: {
              code: result.code,
              message: result.message,
              details: result.details,
            },
            });
          }
        }}
        className="btn btn-danger self-start"
      >
        {pending ? t("deleting") : t("deleteSubmit")}
      </button>
    </section>
  );
}
