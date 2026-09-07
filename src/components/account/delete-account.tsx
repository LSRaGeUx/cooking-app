"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { deleteAccountAction } from "@/app/actions/account-actions";
import { Feedback } from "@/components/feedback";
import { useActionRunner } from "@/lib/use-action-runner";

/**
 * Deleting the account, behind a typed confirmation.
 *
 * A typed word rather than a second button: this is the one action in the
 * product with no undo, and the friction is the point.
 *
 * The word is shown in the label rather than written into it twice, so the
 * sentence and the word the button compares against cannot drift apart. The
 * server accepts the word from any locale's catalogue (see
 * src/lib/delete-confirmation.ts), so the reader is never asked to type a word
 * in a language the interface is not in.
 */
export function DeleteAccount() {
  const t = useTranslations("account");
  const runner = useActionRunner();
  const [confirmation, setConfirmation] = useState("");

  const word = t("deleteConfirmWord");
  const matches = confirmation.trim().toUpperCase() === word.toUpperCase();

  return (
    <section className="flex flex-col gap-3 rounded-[3px] border border-danger-line border-l-[3px] border-l-danger bg-danger-soft p-5">
      <h2 className="eyebrow text-danger-ink">{t("delete")}</h2>
      <p className="hint">{t("deleteHelp")}</p>
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      <label className="label max-w-sm">
        <span>{t("deleteConfirmLabel", { word })}</span>
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className="field font-mono tracking-[0.2em]"
        />
      </label>

      <button
        type="button"
        disabled={runner.pending || !matches}
        onClick={() =>
          void runner.run(() => deleteAccountAction(confirmation), {
            // The action redirects to the login screen on success, so there is
            // nothing left of this page to re-read.
            refresh: false,
          })
        }
        className="btn btn-danger self-start"
      >
        {runner.pending ? t("deleting") : t("deleteSubmit")}
      </button>
    </section>
  );
}
