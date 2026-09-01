import Link from "next/link";

/**
 * The shape every empty screen takes: what is not here, and the one thing to do
 * about it.
 *
 * A bare sentence leaves the reader to work out where to go next, which on a
 * first run is most of the application. One action, never two, so the next step
 * is obvious rather than a choice.
 */
export function EmptyState({
  message,
  help,
  action,
}: {
  message: string;
  help?: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-black/20 px-4 py-8 dark:border-white/25">
      <p className="text-sm">{message}</p>
      {help ? <p className="max-w-prose text-xs opacity-60">{help}</p> : null}
      {action ? (
        <Link
          href={action.href}
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
