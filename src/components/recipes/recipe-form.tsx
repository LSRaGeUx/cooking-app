"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createRecipeAction,
  parseIngredientsAction,
  updateRecipeAction,
} from "@/app/actions/recipe-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import type { RecipeDetail } from "@/services/recipe-service";

/**
 * Creating a recipe has to stay under a minute, because creation speed is what
 * fills the library, and an empty library makes every other feature pointless.
 *
 * Hence the paste box: the fast path is title plus a block of ingredient lines
 * copied from wherever the recipe already lives. The parser turns that into
 * editable rows, and every field it guessed stays editable, which is what lets
 * the parser use cheap heuristics instead of trying to be right about French
 * cooking prose.
 */

interface IngredientRow {
  quantity: string;
  unit: string;
  rawName: string;
  note: string;
  optional: boolean;
}

interface StepRow {
  text: string;
  durationMin: string;
  unattended: boolean;
}

export function RecipeForm({ recipe }: { recipe?: RecipeDetail }) {
  const t = useTranslations("recipes.form");
  const common = useTranslations("common");
  const router = useRouter();

  const [title, setTitle] = useState(recipe?.recipe.title ?? "");
  const [description, setDescription] = useState(
    recipe?.recipe.description ?? "",
  );
  const [imageUrl, setImageUrl] = useState(recipe?.recipe.imageUrl ?? "");
  const [servings, setServings] = useState(String(recipe?.recipe.servings ?? 2));
  const [prepTime, setPrepTime] = useState(numberField(recipe?.recipe.prepTimeMin));
  const [cookTime, setCookTime] = useState(numberField(recipe?.recipe.cookTimeMin));
  const [activeTime, setActiveTime] = useState(
    numberField(recipe?.recipe.activeTimeMin),
  );
  const [batchFriendly, setBatchFriendly] = useState(
    recipe?.recipe.batchFriendly ?? false,
  );
  const [keepsDays, setKeepsDays] = useState(numberField(recipe?.recipe.keepsDays));
  const [tags, setTags] = useState((recipe?.recipe.tags ?? []).join(", "));
  const [cuisine, setCuisine] = useState(recipe?.recipe.cuisine ?? "");
  const [mainProtein, setMainProtein] = useState(recipe?.recipe.mainProtein ?? "");

  const [paste, setPaste] = useState("");
  const [ingredients, setIngredients] = useState<IngredientRow[]>(
    (recipe?.ingredients ?? []).map((line) => ({
      quantity: line.quantity === null ? "" : String(line.quantity),
      unit: line.unit ?? "",
      rawName: line.rawName,
      note: line.note ?? "",
      optional: line.optional,
    })),
  );
  const [steps, setSteps] = useState<StepRow[]>(
    (recipe?.steps ?? []).map((step) => ({
      text: step.text,
      durationMin: numberField(step.durationMin),
      unattended: step.unattended,
    })),
  );

  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);

  async function onParse(): Promise<void> {
    if (paste.trim().length === 0) return;
    setPending(true);
    const result = await parseIngredientsAction(paste);
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: {
          code: result.code,
          message: result.message,
          details: result.details,
        },
      });
      return;
    }
    setIngredients((current) => [
      ...current,
      ...result.data.map((line) => ({
        quantity: line.quantity === null ? "" : String(line.quantity),
        unit: line.unit ?? "",
        rawName: line.rawName,
        note: line.note ?? "",
        optional: line.optional,
      })),
    ]);
    setPaste("");
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setFeedback({});

    const payload = {
      title: title.trim(),
      description: description.trim().length > 0 ? description.trim() : null,
      imageUrl: imageUrl.trim().length > 0 ? imageUrl.trim() : null,
      servings: Number(servings),
      prepTimeMin: optionalNumber(prepTime),
      cookTimeMin: optionalNumber(cookTime),
      activeTimeMin: optionalNumber(activeTime),
      batchFriendly,
      keepsDays: optionalNumber(keepsDays),
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      cuisine: cuisine.trim().length > 0 ? cuisine.trim() : null,
      mainProtein: mainProtein.trim().length > 0 ? mainProtein.trim() : null,
      ingredients: ingredients
        .filter((line) => line.rawName.trim().length > 0)
        .map((line) => ({
          quantity: optionalNumber(line.quantity),
          unit: line.unit.trim().length > 0 ? line.unit.trim() : null,
          rawName: line.rawName.trim(),
          note: line.note.trim().length > 0 ? line.note.trim() : null,
          optional: line.optional,
          ingredientId: null,
        })),
      steps: steps
        .filter((step) => step.text.trim().length > 0)
        .map((step) => ({
          text: step.text.trim(),
          durationMin: optionalNumber(step.durationMin),
          unattended: step.unattended,
        })),
    };

    const result = recipe
      ? await updateRecipeAction(recipe.recipe.id, payload)
      : await createRecipeAction(payload);

    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: {
          code: result.code,
          message: result.message,
          details: result.details,
        },
      });
      return;
    }

    router.push(`/recettes/${result.data.recipe.id}`);
    router.refresh();
  }

  const field = "field";

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <Feedback {...feedback} />

      <section className="flex flex-col gap-3">
        <label className="label">
          <span>{t("name")}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={200}
            placeholder={t("namePlaceholder")}
            className={field}
          />
        </label>

        <label className="label">
          <span>{t("description")}</span>
          <textarea
            value={description}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
            className={field}
          />
        </label>

        <label className="label">
          <span>{t("imageUrl")}</span>
          <input
            value={imageUrl}
            type="url"
            inputMode="url"
            maxLength={2000}
            placeholder={t("imageUrlPlaceholder")}
            onChange={(event) => setImageUrl(event.target.value)}
            className={field}
          />
          <span className="hint">{t("imageUrlHelp")}</span>
        </label>

        <div className="grid gap-3 sm:grid-cols-4">
          <NumberField label={t("servings")} value={servings} onChange={setServings} min={1} />
          <NumberField label={t("prepTime")} value={prepTime} onChange={setPrepTime} />
          <NumberField label={t("cookTime")} value={cookTime} onChange={setCookTime} />
          <NumberField label={t("activeTime")} value={activeTime} onChange={setActiveTime} />
        </div>
        <p className="hint">{t("activeTimeHelp")}</p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="label">
            <span>{t("tags")}</span>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              className={field}
            />
            <span className="hint">{t("tagsHelp")}</span>
          </label>
          <label className="label">
            <span>{t("cuisine")}</span>
            <input
              value={cuisine}
              onChange={(event) => setCuisine(event.target.value)}
              className={field}
            />
          </label>
          <label className="label">
            <span>{t("mainProtein")}</span>
            <input
              value={mainProtein}
              onChange={(event) => setMainProtein(event.target.value)}
              className={field}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={batchFriendly}
              onChange={(event) => setBatchFriendly(event.target.checked)}
            />
            <span>{t("batchFriendly")}</span>
          </label>
          <NumberField label={t("keepsDays")} value={keepsDays} onChange={setKeepsDays} />
        </div>
      </section>

      <section className="flex flex-col gap-3 border-t border-rule pt-6">
        <h2 className="eyebrow eyebrow-rule">{t("paste")}</h2>
        <p className="hint">{t("pasteHelp")}</p>
        <textarea
          value={paste}
          rows={4}
          placeholder={t("pastePlaceholder")}
          onChange={(event) => setPaste(event.target.value)}
          className={field}
        />
        <button
          type="button"
          onClick={() => void onParse()}
          disabled={pending || paste.trim().length === 0}
          className="btn btn-quiet btn-sm self-start"
        >
          {t("parse")}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="eyebrow eyebrow-rule">{t("ingredients")}</h2>
        {ingredients.length === 0 ? (
          <p className="hint">{t("noIngredients")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ingredients.map((line, index) => (
              <li
                key={index}
                className="grid items-end gap-2 sm:grid-cols-[6rem_6rem_1fr_1fr_auto_auto]"
              >
                <TextField
                  label={t("quantity")}
                  value={line.quantity}
                  onChange={(value) => updateAt(setIngredients, index, { quantity: value })}
                />
                <TextField
                  label={t("unit")}
                  value={line.unit}
                  onChange={(value) => updateAt(setIngredients, index, { unit: value })}
                />
                <TextField
                  label={t("ingredientName")}
                  value={line.rawName}
                  onChange={(value) => updateAt(setIngredients, index, { rawName: value })}
                />
                <TextField
                  label={t("note")}
                  value={line.note}
                  onChange={(value) => updateAt(setIngredients, index, { note: value })}
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={line.optional}
                    onChange={(event) =>
                      updateAt(setIngredients, index, { optional: event.target.checked })
                    }
                  />
                  <span>{t("optional")}</span>
                </label>
                <button
                  type="button"
                  aria-label={t("removeIngredient")}
                  onClick={() => removeAt(setIngredients, index)}
                  className="btn btn-quiet btn-sm"
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() =>
            setIngredients((current) => [
              ...current,
              { quantity: "", unit: "", rawName: "", note: "", optional: false },
            ])
          }
          className="btn btn-quiet btn-sm self-start"
        >
          {t("addIngredient")}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="eyebrow eyebrow-rule">{t("steps")}</h2>
        {steps.length === 0 ? (
          <p className="hint">{t("noSteps")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((step, index) => (
              <li
                key={index}
                className="grid items-end gap-2 sm:grid-cols-[1fr_7rem_auto_auto]"
              >
                <TextField
                  label={`${t("stepText")} ${index + 1}`}
                  value={step.text}
                  onChange={(value) => updateAt(setSteps, index, { text: value })}
                />
                <TextField
                  label={t("stepDuration")}
                  value={step.durationMin}
                  onChange={(value) => updateAt(setSteps, index, { durationMin: value })}
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={step.unattended}
                    onChange={(event) =>
                      updateAt(setSteps, index, { unattended: event.target.checked })
                    }
                  />
                  <span>{t("stepUnattended")}</span>
                </label>
                <button
                  type="button"
                  aria-label={t("removeStep")}
                  onClick={() => removeAt(setSteps, index)}
                  className="btn btn-quiet btn-sm"
                >
                  &times;
                </button>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          onClick={() =>
            setSteps((current) => [
              ...current,
              { text: "", durationMin: "", unattended: false },
            ])
          }
          className="btn btn-quiet btn-sm self-start"
        >
          {t("addStep")}
        </button>
      </section>

      <button
        type="submit"
        disabled={pending || title.trim().length === 0}
        className="btn btn-primary self-start"
      >
        {pending ? common("saving") : common("save")}
      </button>
    </form>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="label">
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
}) {
  return (
    <label className="label">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field"
      />
    </label>
  );
}

function updateAt<T>(
  setter: React.Dispatch<React.SetStateAction<T[]>>,
  index: number,
  changes: Partial<T>,
): void {
  setter((current) =>
    current.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...changes } : row,
    ),
  );
}

function removeAt<T>(
  setter: React.Dispatch<React.SetStateAction<T[]>>,
  index: number,
): void {
  setter((current) => current.filter((_, rowIndex) => rowIndex !== index));
}

function numberField(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
