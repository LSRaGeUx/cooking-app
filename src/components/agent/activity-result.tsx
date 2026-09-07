import { getTranslations } from "next-intl/server";
import type { ActivityResult } from "@/domain/vocabulary";

/**
 * What came of one agent call, said once.
 *
 * The label and the colour were written out twice, on the agent screen as a
 * coloured dot and on the activity log as a chip, each with its own three-way
 * ternary. Two copies of one mapping is how a fourth result value ends up
 * drawn as an error on one screen and as nothing on the other.
 *
 * A server component, because both callers are pages: nothing here is
 * interactive and the strings are already being fetched on the server.
 */
export async function ActivityResultChip({
  result,
  rejectionCode,
}: {
  result: ActivityResult;
  rejectionCode: string | null;
}) {
  const t = await getTranslations("agent");

  return (
    <span className={`chip ${CHIP_CLASS[result]}`}>
      {text(t, result, rejectionCode)}
    </span>
  );
}

/** The same outcome as a single dot, for the summary list. */
export async function ActivityResultDot({
  result,
  rejectionCode,
}: {
  result: ActivityResult;
  rejectionCode: string | null;
}) {
  const t = await getTranslations("agent");

  return (
    <>
      {/* One dot, one glance: green ran, amber refused, red broke. */}
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[result]}`}
      />
      <span className={`micro ${result === "ok" ? "" : "text-amber-ink"}`}>
        {text(t, result, rejectionCode)}
      </span>
    </>
  );
}

const CHIP_CLASS: Record<ActivityResult, string> = {
  ok: "chip-ok",
  rejected: "chip-warn",
  error: "chip-danger",
};

const DOT_CLASS: Record<ActivityResult, string> = {
  ok: "bg-olive",
  rejected: "bg-amber-ink",
  error: "bg-danger",
};

function text(
  t: Awaited<ReturnType<typeof getTranslations>>,
  result: ActivityResult,
  rejectionCode: string | null,
): string {
  if (result === "ok") return t("resultOk");
  if (result === "error") return t("resultError");
  // The code is the useful half of a refusal: it says which rule fired.
  return rejectionCode
    ? `${t("resultRejected")} · ${rejectionCode}`
    : t("resultRejected");
}
