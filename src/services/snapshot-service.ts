import {
  DEFAULT_SNAPSHOT_FACT_BUDGET,
  orderTasteFacts,
  renderSnapshotMarkdown,
  sectionOfFact,
  selectFactsForBudget,
  snapshotSlots,
  type ProfileSnapshot,
  type RankedFact,
  type SnapshotFact,
} from "@/domain/snapshot";
import { DEFAULT_FACT_CAP, type Diet } from "@/domain/vocabulary";
import { inScope, type ServiceContext } from "./context";
import { listFacts, markFactsReferenced } from "./fact-service";
import { loadHistory, loadSignals } from "./history-service";
import { listPantry, type PantryItemView } from "./pantry-service";
import { loadEnforcementContext } from "./profile-service";
import { loadSlotDefinitions } from "./slot-service";

/**
 * Composing the profile snapshot: the single most important artifact in the
 * system, and the one the whole product is really selling.
 *
 * It is deliberately visible in the UI from phase 3, before any agent can read
 * it. Reading the document we assemble is the fastest way to find out whether
 * the context is any good, and it is testable by eye.
 */

export interface SnapshotResult {
  readonly snapshot: ProfileSnapshot;
  readonly markdown: string;
}

export interface ComposeOptions {
  readonly factBudget?: number;
  /**
   * Whether to record that these facts were handed out. True for a real read,
   * false when the UI is only previewing the document, so that looking at your
   * own snapshot does not distort the pruning heuristic.
   */
  readonly markReferenced?: boolean;
}

function toSnapshotPantryItem(item: PantryItemView) {
  return {
    name: item.name,
    quantityNote: item.quantityNote,
    expiresOn: item.expiresOn,
  };
}

export async function composeProfileSnapshot(
  ctx: ServiceContext,
  options: ComposeOptions = {},
): Promise<SnapshotResult> {
  const budget = options.factBudget ?? DEFAULT_SNAPSHOT_FACT_BUDGET;

  return inScope(ctx, async (scoped) => {
    const enforcement = await loadEnforcementContext(scoped);
    const slots = await loadSlotDefinitions(scoped);
    const activeFacts = await listFacts(scoped, {});
    // Four weeks, per the section ordering: enough to see a pattern, short
    // enough that the document stays readable.
    const history = await loadHistory(scoped, 4);
    const { signals } = await loadSignals(scoped);
    const pantry = await listPantry(scoped);

    // No narrowing needed on the way in any more: `FactView` carries the
    // vocabulary unions, and `RankedFact` wants exactly those, so a value the
    // database holds but the union does not know about cannot reach the label
    // records in src/domain/snapshot.ts. Those records are exhaustive and their
    // runtime fallbacks are gone, so a missing label is now a build error
    // rather than a raw database token rendered into the document an agent
    // reads as instructions.
    const ranked: RankedFact[] = activeFacts.map((row) => ({
      id: row.id,
      statement: row.statement,
      category: row.category,
      polarity: row.polarity,
      confidence: row.confidence,
      status: row.status,
      source: row.source,
      lastReferencedAt: row.lastReferencedAt,
      createdAt: row.createdAt,
    }));

    const selected = selectFactsForBudget(ranked, budget);

    const strong: SnapshotFact[] = [];
    const kitchen: SnapshotFact[] = [];
    const organization: SnapshotFact[] = [];
    const taste: SnapshotFact[] = [];

    for (const row of selected) {
      const view: SnapshotFact = {
        id: row.id,
        statement: row.statement,
        category: row.category,
        polarity: row.polarity,
        confidence: row.confidence,
        status: row.status,
        source: row.source,
      };
      switch (sectionOfFact(view)) {
        case "strong":
          strong.push(view);
          break;
        case "kitchen":
          kitchen.push(view);
          break;
        case "organization":
          organization.push(view);
          break;
        default:
          taste.push(view);
      }
    }

    const profile = enforcement.profile;

    const snapshot: ProfileSnapshot = {
      generatedAt: new Date().toISOString(),
      factBudget: {
        included: selected.length,
        active: activeFacts.length,
        // The store's cap, which is what the field name and the rendered
        // sentence ("plafond d'affichage") both claim. It was
        // `Math.min(budget, DEFAULT_FACT_CAP)`, which for every real call is
        // the budget again: the document then told the agent that the cap on
        // the number of facts it could hold was 150, when it is 300, and an
        // agent that believes it is near a cap starts retiring facts to make
        // room it already has.
        cap: DEFAULT_FACT_CAP,
      },
      hardConstraints: {
        strictAllergens: enforcement.allergens
          .filter((allergen) => allergen.severity === "strict")
          .map((allergen) => ({
            name: allergen.name,
            matches: [...allergen.matches],
          })),
        // `profile.diet` is `text` plus `check profile_diet_known`, so Drizzle
        // types it `string`. Narrowed here, at the boundary, because
        // `DIET_LABELS` is exhaustive over `Diet` and a value outside the union
        // would index it with nothing there.
        diet: profile.diet as Diet,
        dietNotes: profile.dietNotes,
      },
      strongPreferences: {
        exclusions: enforcement.exclusions.map((exclusion) => ({
          name: exclusion.name,
          matches: [...exclusion.matches],
        })),
        avoidAllergens: enforcement.allergens
          .filter((allergen) => allergen.severity === "avoid")
          .map((allergen) => ({
            name: allergen.name,
            matches: [...allergen.matches],
          })),
        facts: strong,
      },
      weekShape: {
        slots: snapshotSlots(slots),
        defaultServings: profile.defaultServings,
        defaultTimeBudgetMin: profile.defaultTimeBudgetMin,
        timeBudgetToleranceMin: profile.timeBudgetToleranceMin,
        varietyPreference: profile.varietyPreference,
        shoppingDay: profile.shoppingDay,
      },
      kitchen: {
        skillLevel: profile.skillLevel,
        equipment: enforcement.equipmentKeys,
        facts: kitchen,
      },
      organizationFacts: organization,
      tasteFacts: orderTasteFacts(taste),
      pantry: {
        staples: pantry
          .filter((item) => item.kind === "staple")
          .map(toSnapshotPantryItem),
        // Expiring first: this list exists to change what gets cooked next.
        useSoon: pantry
          .filter((item) => item.kind === "use_soon")
          .map(toSnapshotPantryItem),
      },
      recentHistory: history.map((historyWeek) => ({
        year: historyWeek.year,
        week: historyWeek.week,
        meals: historyWeek.entries.map((entry) => ({
          dayOfWeek: entry.dayOfWeek,
          title: entry.recipeTitle,
          outcome: entry.outcome,
          rating: entry.rating,
          swappedFor: entry.swappedFor,
        })),
      })),
      unresolvedSignals: signals.map((signal) => ({
        code: signal.code,
        message: signal.message,
      })),
      // Every section the model defines is now filled. The field stays so a
      // future gap can be declared rather than rendered as silence.
      unavailable: [],
    };

    if (options.markReferenced) {
      await markFactsReferenced(
        scoped,
        selected.map((row) => row.id),
      );
    }

    return { snapshot, markdown: renderSnapshotMarkdown(snapshot) };
  });
}
