"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

/**
 * The document an agent reads, shown to the user.
 *
 * Making it visible in phase 3, before any agent can connect, is deliberate: it
 * is the fastest way to find out whether the context we assemble is any good,
 * and it is testable by reading it.
 */
export function SnapshotView({
  markdown,
  json,
}: {
  markdown: string;
  json: string;
}) {
  const t = useTranslations("snapshot");
  const [tab, setTab] = useState<"markdown" | "json">("markdown");
  const [copied, setCopied] = useState(false);

  const content = tab === "markdown" ? markdown : json;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard the browser refuses is not worth an error banner: the text
      // is right there to select.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-black/15 dark:border-white/20">
          <button
            type="button"
            onClick={() => setTab("markdown")}
            aria-pressed={tab === "markdown"}
            className={`px-3 py-1.5 text-sm ${
              tab === "markdown" ? "bg-black/10 font-medium dark:bg-white/15" : ""
            }`}
          >
            {t("markdown")}
          </button>
          <button
            type="button"
            onClick={() => setTab("json")}
            aria-pressed={tab === "json"}
            className={`px-3 py-1.5 text-sm ${
              tab === "json" ? "bg-black/10 font-medium dark:bg-white/15" : ""
            }`}
          >
            {t("json")}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>

      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-black/10 p-4 text-xs leading-relaxed dark:border-white/15">
        {content}
      </pre>
    </div>
  );
}
