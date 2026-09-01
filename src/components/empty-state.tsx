import Link from "next/link";

/**
 * The shape every empty screen takes: what is not here, and the one thing to do
 * about it.
 *
 * A bare sentence leaves the reader to work out where to go next, which on a
 * first run is most of the application. One action, never two, so the next step
 * is obvious rather than a choice.
 *
 * Drawn as a blank slip waiting to be filled in, dashed rule and all, rather
 * than as an error: nothing has gone wrong here.
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
    <div className="flex flex-col items-start gap-5 rounded-[3px] border border-dashed border-rule-strong bg-surface/40 px-8 py-14">
      <p className="display max-w-[24ch] text-[clamp(1.6rem,3vw,2.4rem)] leading-tight">
        {message}
      </p>
      {help ? <p className="hint">{help}</p> : null}
      {action ? (
        <Link href={action.href} className="btn btn-primary">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
