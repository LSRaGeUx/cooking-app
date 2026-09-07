"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { SlotDefinition } from "@/domain/slots";
import { parseSlotKey, slotKey } from "@/lib/slot-key";
import type { PlanEntryView } from "@/services/plan-service";

/**
 * Servings, a note, duplicate to another slot, or clear. Duplicating to another
 * slot is how a user expresses leftovers before prep links exist, so it is a
 * first-class button rather than a hidden gesture.
 */
export interface PrepCandidate {
  readonly entryId: string;
  readonly dayOfWeek: number;
  readonly label: string;
}

export function EntryPanel({
  entry,
  slots,
  disabled = false,
  prepSourceId,
  prepCandidates,
  onSave,
  onDuplicate,
  onClear,
  onClose,
  onLinkPrep,
  onUnlinkPrep,
}: {
  entry: PlanEntryView;
  slots: readonly SlotDefinition[];
  disabled?: boolean;
  prepSourceId: string | null;
  prepCandidates: readonly PrepCandidate[];
  onSave: (changes: { servings: number; note: string | null }) => void;
  onDuplicate: (target: { dayOfWeek: number; mealTypeId: string }) => void;
  onClear: () => void;
  onClose: () => void;
  onLinkPrep: (sourceEntryId: string) => void;
  onUnlinkPrep: () => void;
}) {
  const t = useTranslations("week");
  const common = useTranslations("common");
  const days = useTranslations("week.days");

  const [servings, setServings] = useState(entry.servings);
  const [note, setNote] = useState(entry.note ?? "");
  const [duplicateTarget, setDuplicateTarget] = useState("");

  const targets = slots.filter(
    (slot) =>
      slot.state === "planned" &&
      !(
        slot.dayOfWeek === entry.dayOfWeek &&
        slot.mealTypeId === entry.mealTypeId
      ),
  );

  return (
    /*
     * No role and no label of its own: this is always rendered inside the
     * shared <Modal>, which is a real <dialog> opened with showModal(), so the
     * dialog role, the modal semantics, the focus trap and the label come from
     * the element around it. Declaring them again here nested one dialog inside
     * another as far as a screen reader was concerned.
     */
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="display text-base leading-snug">
          {entry.recipeTitleSnapshot}
        </h3>
        <button type="button" onClick={onClose} className="link text-xs">
          {common("close")}
        </button>
      </div>

      <label className="label">
        <span>{t("servingsLabel")}</span>
        <input
          type="number"
          min={1}
          max={50}
          value={servings}
          onChange={(event) => setServings(Number(event.target.value))}
          className="w-24"
        />
      </label>

      <label className="label">
        <span>{t("noteLabel")}</span>
        <textarea
          value={note}
          rows={2}
          placeholder={t("notePlaceholder")}
          onChange={(event) => setNote(event.target.value)}
          className="field"
        />
      </label>

      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onSave({
            servings,
            note: note.trim().length > 0 ? note.trim() : null,
          })
        }
        className="btn btn-primary self-start"
      >
        {disabled ? common("saving") : common("save")}
      </button>

      <div className="flex flex-col gap-2 border-t border-rule pt-4">
        <label className="label">
          <span>{t("duplicate")}</span>
          <select
            value={duplicateTarget}
            onChange={(event) => setDuplicateTarget(event.target.value)}
            className="field"
          >
            <option value="">{common("none")}</option>
            {targets.map((slot) => (
              <option
                key={slotKey(slot.dayOfWeek, slot.mealTypeId)}
                value={slotKey(slot.dayOfWeek, slot.mealTypeId)}
              >
                {days(String(slot.dayOfWeek))} {slot.mealTypeLabel}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled || duplicateTarget === ""}
          onClick={() => {
            // One parser, shared with the grid and the slot editor. This used
            // to split on every colon, which loses anything after a second one.
            const target = parseSlotKey(duplicateTarget);
            if (!target) return;
            onDuplicate(target);
          }}
          className="btn btn-quiet btn-sm self-start"
        >
          {t("duplicate")}
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-rule pt-4">
        <label className="label">
          <span>{t("prepLink")}</span>
          <select
            value={prepSourceId ?? ""}
            disabled={disabled}
            onChange={(event) =>
              event.target.value === ""
                ? onUnlinkPrep()
                : onLinkPrep(event.target.value)
            }
            className="field"
          >
            <option value="">{t("prepLinkNone")}</option>
            {prepCandidates.map((candidate) => (
              <option key={candidate.entryId} value={candidate.entryId}>
                {candidate.label}
              </option>
            ))}
          </select>
          <span className="hint">{t("prepLinkHelp")}</span>
        </label>
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={onClear}
        className="btn btn-danger btn-sm self-start"
      >
        {t("clear")}
      </button>
    </div>
  );
}
