"use client";

import { useEffect, useRef } from "react";

/**
 * A modal block. Bottom sheet on a phone, centred slab on a desk.
 *
 * A real `<dialog>` opened with `showModal()`, which is the only reason this
 * component exists. The previous overlay was a `div` with a full-screen button
 * behind it: no `aria-modal`, nothing announcing a dialog had opened, focus
 * left on whatever had been clicked, the whole page behind still reachable with
 * Tab, and nothing returning focus to the trigger on close. A keyboard or
 * screen-reader user could tab out of the panel into the week grid underneath
 * and edit a different meal without the panel ever closing.
 *
 * `showModal()` gives all of that from the platform: the top layer, the
 * inertness of everything behind it, the focus trap, the Escape handling, and
 * the return of focus to the element that was focused when the dialog opened.
 * Every one of those was a hand-written approximation before, and the focus
 * trap was simply missing.
 *
 * The dialog element itself is the backdrop, so a click that lands on it rather
 * than on the panel inside is a click outside, which closes. That replaces the
 * button that used to sit under the panel purely to be clicked, and which a
 * screen reader read out as a button called "Close" wrapping the whole screen.
 */
export function Modal({
  label,
  onClose,
  children,
}: {
  /** Names the dialog. Read out when it opens. */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  /*
   * `onClose` is held in a ref so this effect runs once, on mount. Every call
   * site passes an inline arrow, so depending on it directly would close and
   * reopen the dialog on every render of the parent, which loses focus and
   * replays the open animation.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();

    // Fires for Escape and for `close()`, so there is one path out and the
    // parent's state cannot disagree with whether the dialog is open.
    const handleClose = (): void => onCloseRef.current();
    dialog.addEventListener("close", handleClose);

    return () => {
      dialog.removeEventListener("close", handleClose);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClick={(event) => {
        // Only when the click landed on the dialog box itself, which is the
        // area outside the panel. A click inside the panel hits a child.
        if (event.target === ref.current) ref.current?.close();
      }}
      className="modal"
    >
      <div className="modal-panel">{children}</div>
    </dialog>
  );
}
