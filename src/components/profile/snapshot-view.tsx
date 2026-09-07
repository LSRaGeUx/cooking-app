"use client";

import { useEffect, useRef, useState } from "react";
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

  // Cleared on unmount: a navigation inside two seconds of a copy used to call
  // setState on a component that was gone.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard the browser refuses is not worth an error banner: the text
      // is right there to select.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {/*
          `aria-current` only. Both attributes were set on both buttons, and
          they say different things: aria-pressed makes each one a toggle that
          is on or off, aria-current makes the pair a set with one selected.
          A screen reader announced "pressed, current", which is a control that
          does not exist. This is a set with one selected, and .segmented styles
          on aria-current, so that is the one that stays.
        */}
        <div className="segmented">
          <button
            type="button"
            onClick={() => setTab("markdown")}
            aria-current={tab === "markdown" ? "true" : undefined}
          >
            {t("markdown")}
          </button>
          <button
            type="button"
            onClick={() => setTab("json")}
            aria-current={tab === "json" ? "true" : undefined}
          >
            {t("json")}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void copy()}
          className="btn btn-quiet btn-sm"
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>

      {/*
        The document as the agent receives it, on its own ground: this is the
        one screen in the app that is not the app talking, it is the payload.
      */}
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-[3px] border border-rule border-l-[3px] border-l-agent bg-sunk p-5 leading-relaxed">
        {content}
      </pre>
    </div>
  );
}
