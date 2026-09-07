"use client";

import { useReducer } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createRecipeAction,
  parseIngredientsAction,
  updateRecipeAction,
} from "@/app/actions/recipe-actions";
import { Feedback } from "@/components/feedback";
import { recipeInputSchema } from "@/domain/schemas";
import { optionalNumber } from "@/lib/form-values";
import { useActionRunner } from "@/lib/use-action-runner";
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
 *
 * One `useReducer` rather than sixteen `useState` calls. Sixteen setters for
 * one object is sixteen chances to update one and forget another, and the two
 * row lists need operations (add, patch at index, remove at index) that read as
 * actions rather than as replacements.
 */

/**
 * Field lengths read off the Zod schema rather than written out again. The form
 * used to hardcode `maxLength={200}` and `{2000}`, so a limit changed in the
 * schema would have been enforced on the server and not in the browser: the
 * user types past it and finds out on submit.
 */
const TITLE_MAX = recipeInputSchema.shape.title.maxLength ?? undefined;

interface IngredientRow {
  /**
   * A client-generated id, used as the React key.
   *
   * The rows used to be keyed by index, so deleting row N re-bound every input
   * after it to a different row: the values shifted up under the cursor and
   * focus landed in a field the user had not clicked on.
   */
  readonly id: string;
  quantity: string;
  unit: string;
  rawName: string;
  note: string;
  optional: boolean;
  /**
   * The ingredient this line already resolves to, carried through a save.
   *
   * It used to be sent as `null` on every save, which discarded the stored
   * link and left the service to re-resolve the line by its raw name. A line
   * renamed from "oignon jaune" to "oignons jaunes" then silently lost its
   * ingredient, and with it the density and the allergen terms hanging off it.
   */
  readonly ingredientId: string | null;
}

interface StepRow {
  readonly id: string;
  text: string;
  durationMin: string;
  unattended: boolean;
}

interface FormState {
  title: string;
  description: string;
  imageUrl: string;
  servings: string;
  prepTime: string;
  cookTime: string;
  activeTime: string;
  batchFriendly: boolean;
  keepsDays: string;
  tags: string;
  cuisine: string;
  mainProtein: string;
  paste: string;
  ingredients: IngredientRow[];
  steps: StepRow[];
}

type FormAction =
  | { type: "field"; key: ScalarKey; value: string }
  | { type: "batchFriendly"; value: boolean }
  | { type: "addIngredient" }
  | { type: "appendIngredients"; rows: IngredientRow[] }
  | { type: "patchIngredient"; id: string; changes: Partial<IngredientRow> }
  | { type: "removeIngredient"; id: string }
  | { type: "addStep" }
  | { type: "patchStep"; id: string; changes: Partial<StepRow> }
  | { type: "removeStep"; id: string };

/** Every field of the state that is a plain string. */
type ScalarKey = {
  [K in keyof FormState]: FormState[K] extends string ? K : never;
}[keyof FormState];

function reduce(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "field":
      return { ...state, [action.key]: action.value };
    case "batchFriendly":
      return { ...state, batchFriendly: action.value };
    case "addIngredient":
      return {
        ...state,
        ingredients: [...state.ingredients, emptyIngredient()],
      };
    case "appendIngredients":
      return { ...state, ingredients: [...state.ingredients, ...action.rows] };
    case "patchIngredient":
      return {
        ...state,
        ingredients: state.ingredients.map((row) =>
          row.id === action.id ? { ...row, ...action.changes } : row,
        ),
      };
    case "removeIngredient":
      return {
        ...state,
        ingredients: state.ingredients.filter((row) => row.id !== action.id),
      };
    case "addStep":
      return { ...state, steps: [...state.steps, emptyStep()] };
    case "patchStep":
      return {
        ...state,
        steps: state.steps.map((row) =>
          row.id === action.id ? { ...row, ...action.changes } : row,
        ),
      };
    case "removeStep":
      return {
        ...state,
        steps: state.steps.filter((row) => row.id !== action.id),
      };
  }
}

export function RecipeForm({ recipe }: { recipe?: RecipeDetail }) {
  const t = useTranslations("recipes.form");
  const common = useTranslations("common");
  const router = useRouter();
  const runner = useActionRunner();

  const [state, dispatch] = useReducer(reduce, recipe, initialState);

  const set = (key: ScalarKey) => (value: string) =>
    dispatch({ type: "field", key, value });

  function onParse(): void {
    if (state.paste.trim().length === 0) return;
    void runner.run(() => parseIngredientsAction(state.paste), {
      refresh: false,
      onSuccess: (lines) => {
        dispatch({
          type: "appendIngredients",
          rows: lines.map((line) => ({
            id: rowId(),
            quantity: line.quantity === null ? "" : String(line.quantity),
            unit: line.unit ?? "",
            rawName: line.rawName,
            note: line.note ?? "",
            optional: line.optional,
            // A parsed line has never been resolved to an ingredient.
            ingredientId: null,
          })),
        });
        dispatch({ type: "field", key: "paste", value: "" });
      },
    });
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const payload = {
      title: state.title.trim(),
      description: state.description.trim() || null,
      imageUrl: state.imageUrl.trim() || null,
      servings: Number(state.servings),
      prepTimeMin: optionalNumber(state.prepTime),
      cookTimeMin: optionalNumber(state.cookTime),
      activeTimeMin: optionalNumber(state.activeTime),
      batchFriendly: state.batchFriendly,
      keepsDays: optionalNumber(state.keepsDays),
      tags: state.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      cuisine: state.cuisine.trim() || null,
      mainProtein: state.mainProtein.trim() || null,
      ingredients: state.ingredients
        .filter((line) => line.rawName.trim().length > 0)
        .map((line) => ({
          quantity: optionalNumber(line.quantity),
          unit: line.unit.trim() || null,
          rawName: line.rawName.trim(),
          note: line.note.trim() || null,
          optional: line.optional,
          ingredientId: line.ingredientId,
        })),
      steps: state.steps
        .filter((step) => step.text.trim().length > 0)
        .map((step) => ({
          text: step.text.trim(),
          durationMin: optionalNumber(step.durationMin),
          unattended: step.unattended,
        })),
    };

    void runner.run(
      () =>
        recipe
          ? updateRecipeAction(recipe.recipe.id, payload)
          : createRecipeAction(payload),
      {
        refresh: false,
        onSuccess: (detail) => {
          router.push(`/recettes/${detail.recipe.id}`);
          router.refresh();
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      <section className="flex flex-col gap-3">
        <label className="label">
          <span>{t("name")}</span>
          <input
            value={state.title}
            onChange={(event) => set("title")(event.target.value)}
            required
            maxLength={TITLE_MAX}
            placeholder={t("namePlaceholder")}
            className="field"
          />
        </label>

        <label className="label">
          <span>{t("description")}</span>
          <textarea
            value={state.description}
            rows={2}
            onChange={(event) => set("description")(event.target.value)}
            className="field"
          />
        </label>

        <label className="label">
          <span>{t("imageUrl")}</span>
          <input
            value={state.imageUrl}
            type="url"
            inputMode="url"
            maxLength={IMAGE_URL_MAX}
            placeholder={t("imageUrlPlaceholder")}
            onChange={(event) => set("imageUrl")(event.target.value)}
            className="field"
          />
          <span className="hint">{t("imageUrlHelp")}</span>
        </label>

        <div className="grid gap-3 sm:grid-cols-4">
          <NumberField
            label={t("servings")}
            value={state.servings}
            onChange={set("servings")}
            min={1}
          />
          <NumberField
            label={t("prepTime")}
            value={state.prepTime}
            onChange={set("prepTime")}
          />
          <NumberField
            label={t("cookTime")}
            value={state.cookTime}
            onChange={set("cookTime")}
          />
          <NumberField
            label={t("activeTime")}
            value={state.activeTime}
            onChange={set("activeTime")}
          />
        </div>
        <p className="hint">{t("activeTimeHelp")}</p>

        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label={t("tags")}
            value={state.tags}
            onChange={set("tags")}
            help={t("tagsHelp")}
          />
          <TextField
            label={t("cuisine")}
            value={state.cuisine}
            onChange={set("cuisine")}
          />
          <TextField
            label={t("mainProtein")}
            value={state.mainProtein}
            onChange={set("mainProtein")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={state.batchFriendly}
              onChange={(event) =>
                dispatch({ type: "batchFriendly", value: event.target.checked })
              }
            />
            <span>{t("batchFriendly")}</span>
          </label>
          <NumberField
            label={t("keepsDays")}
            value={state.keepsDays}
            onChange={set("keepsDays")}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3 border-t border-rule pt-6">
        <h2 className="eyebrow eyebrow-rule">{t("paste")}</h2>
        <p className="hint">{t("pasteHelp")}</p>
        <textarea
          value={state.paste}
          rows={4}
          placeholder={t("pastePlaceholder")}
          onChange={(event) => set("paste")(event.target.value)}
          className="field"
        />
        <button
          type="button"
          onClick={onParse}
          disabled={runner.pending || state.paste.trim().length === 0}
          className="btn btn-quiet btn-sm self-start"
        >
          {t("parse")}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="eyebrow eyebrow-rule">{t("ingredients")}</h2>
        {state.ingredients.length === 0 ? (
          <p className="hint">{t("noIngredients")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.ingredients.map((line) => (
              <li
                key={line.id}
                className="grid items-end gap-2 sm:grid-cols-[6rem_6rem_1fr_1fr_auto_auto]"
              >
                <TextField
                  label={t("quantity")}
                  value={line.quantity}
                  onChange={(quantity) =>
                    dispatch({
                      type: "patchIngredient",
                      id: line.id,
                      changes: { quantity },
                    })
                  }
                />
                <TextField
                  label={t("unit")}
                  value={line.unit}
                  onChange={(unit) =>
                    dispatch({
                      type: "patchIngredient",
                      id: line.id,
                      changes: { unit },
                    })
                  }
                />
                <TextField
                  label={t("ingredientName")}
                  value={line.rawName}
                  onChange={(rawName) =>
                    dispatch({
                      type: "patchIngredient",
                      id: line.id,
                      changes: { rawName },
                    })
                  }
                />
                <TextField
                  label={t("note")}
                  value={line.note}
                  onChange={(note) =>
                    dispatch({
                      type: "patchIngredient",
                      id: line.id,
                      changes: { note },
                    })
                  }
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={line.optional}
                    onChange={(event) =>
                      dispatch({
                        type: "patchIngredient",
                        id: line.id,
                        changes: { optional: event.target.checked },
                      })
                    }
                  />
                  <span>{t("optional")}</span>
                </label>
                <button
                  type="button"
                  aria-label={t("removeIngredient")}
                  onClick={() =>
                    dispatch({ type: "removeIngredient", id: line.id })
                  }
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
          onClick={() => dispatch({ type: "addIngredient" })}
          className="btn btn-quiet btn-sm self-start"
        >
          {t("addIngredient")}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="eyebrow eyebrow-rule">{t("steps")}</h2>
        {state.steps.length === 0 ? (
          <p className="hint">{t("noSteps")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {state.steps.map((step, index) => (
              <li
                key={step.id}
                className="grid items-end gap-2 sm:grid-cols-[1fr_7rem_auto_auto]"
              >
                <TextField
                  label={`${t("stepText")} ${index + 1}`}
                  value={step.text}
                  onChange={(text) =>
                    dispatch({
                      type: "patchStep",
                      id: step.id,
                      changes: { text },
                    })
                  }
                />
                <TextField
                  label={t("stepDuration")}
                  value={step.durationMin}
                  onChange={(durationMin) =>
                    dispatch({
                      type: "patchStep",
                      id: step.id,
                      changes: { durationMin },
                    })
                  }
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={step.unattended}
                    onChange={(event) =>
                      dispatch({
                        type: "patchStep",
                        id: step.id,
                        changes: { unattended: event.target.checked },
                      })
                    }
                  />
                  <span>{t("stepUnattended")}</span>
                </label>
                <button
                  type="button"
                  aria-label={t("removeStep")}
                  onClick={() => dispatch({ type: "removeStep", id: step.id })}
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
          onClick={() => dispatch({ type: "addStep" })}
          className="btn btn-quiet btn-sm self-start"
        >
          {t("addStep")}
        </button>
      </section>

      <button
        type="submit"
        disabled={runner.pending || state.title.trim().length === 0}
        className="btn btn-primary self-start"
      >
        {runner.pending ? common("saving") : common("save")}
      </button>
    </form>
  );
}

/**
 * The same bound `recipeInputSchema.imageUrl` puts on a stored address. That
 * field is wrapped in `.nullable().default(null)`, so its length is not on the
 * public surface of the schema object the way the title's is, and reaching
 * through the wrappers would mean reading Zod's internals. Left as the literal
 * with the schema named, which is the honest version of a duplicate.
 */
const IMAGE_URL_MAX = 2000;

function TextField({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
}) {
  return (
    <label className="label">
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field"
      />
      {help ? <span className="hint">{help}</span> : null}
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

function initialState(recipe: RecipeDetail | undefined): FormState {
  return {
    title: recipe?.recipe.title ?? "",
    description: recipe?.recipe.description ?? "",
    imageUrl: recipe?.recipe.imageUrl ?? "",
    servings: String(recipe?.recipe.servings ?? 2),
    prepTime: numberField(recipe?.recipe.prepTimeMin),
    cookTime: numberField(recipe?.recipe.cookTimeMin),
    activeTime: numberField(recipe?.recipe.activeTimeMin),
    batchFriendly: recipe?.recipe.batchFriendly ?? false,
    keepsDays: numberField(recipe?.recipe.keepsDays),
    tags: (recipe?.recipe.tags ?? []).join(", "),
    cuisine: recipe?.recipe.cuisine ?? "",
    mainProtein: recipe?.recipe.mainProtein ?? "",
    paste: "",
    // Existing rows are keyed by the id they already have, so the key is
    // stable across a server render and its hydration without a counter having
    // to agree on both sides.
    ingredients: (recipe?.ingredients ?? []).map((line) => ({
      id: line.id,
      quantity: line.quantity === null ? "" : String(line.quantity),
      unit: line.unit ?? "",
      rawName: line.rawName,
      note: line.note ?? "",
      optional: line.optional,
      ingredientId: line.ingredientId,
    })),
    steps: (recipe?.steps ?? []).map((step) => ({
      id: step.id,
      text: step.text,
      durationMin: numberField(step.durationMin),
      unattended: step.unattended,
    })),
  };
}

function emptyIngredient(): IngredientRow {
  return {
    id: rowId(),
    quantity: "",
    unit: "",
    rawName: "",
    note: "",
    optional: false,
    ingredientId: null,
  };
}

function emptyStep(): StepRow {
  return { id: rowId(), text: "", durationMin: "", unattended: false };
}

/**
 * A key for a row the user has just added, unique within the page.
 *
 * Only ever called from a click handler or from the parse result, so it runs in
 * the browser and never has to match anything the server rendered. Rows that
 * came from the database keep their own id instead.
 */
let nextRowId = 0;
function rowId(): string {
  nextRowId += 1;
  return `new-${nextRowId}`;
}

function numberField(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}
