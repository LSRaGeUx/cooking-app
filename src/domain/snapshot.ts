import { dayName, type SlotDefinition } from "./slots";

/**
 * The profile snapshot: one document, assembled server-side, meant to be enough
 * for an agent to plan a week without reading anything else.
 *
 * The ordering in `03-agent-interface.md` section 4 is the design, not a
 * formatting choice. Hard constraints come first and are phrased imperatively
 * because models weight early explicit instructions more heavily, and this is
 * the one place where a miss is a health event rather than a bad dinner.
 *
 * Everything here is pure. Reading the data and recording that the facts were
 * referenced is the service's job.
 */

export interface SnapshotFact {
  readonly id: string;
  readonly statement: string;
  readonly category: string;
  readonly polarity: string;
  readonly confidence: string;
  readonly status: string;
  readonly source: string;
}

export interface SnapshotAllergen {
  readonly name: string;
  readonly matches: readonly string[];
}

export interface SnapshotSlot {
  readonly dayOfWeek: number;
  readonly mealTypeLabel: string;
  readonly state: string;
  readonly timeBudgetMin: number | null;
  readonly defaultServings: number | null;
}

export interface UnavailableSection {
  readonly section: string;
  readonly reason: string;
}

export interface ProfileSnapshot {
  readonly generatedAt: string;
  readonly factBudget: {
    readonly included: number;
    readonly active: number;
    readonly cap: number;
  };
  readonly hardConstraints: {
    readonly strictAllergens: SnapshotAllergen[];
    readonly diet: string;
    readonly dietNotes: string | null;
  };
  readonly strongPreferences: {
    readonly exclusions: SnapshotAllergen[];
    readonly avoidAllergens: SnapshotAllergen[];
    readonly facts: SnapshotFact[];
  };
  readonly weekShape: {
    readonly slots: SnapshotSlot[];
    readonly defaultServings: number;
    readonly defaultTimeBudgetMin: number | null;
    readonly timeBudgetToleranceMin: number;
    readonly varietyPreference: number;
  };
  readonly kitchen: {
    readonly skillLevel: number;
    readonly equipment: string[];
    readonly facts: SnapshotFact[];
  };
  readonly organizationFacts: SnapshotFact[];
  readonly tasteFacts: SnapshotFact[];
  /** Sections the spec defines that this build cannot fill yet. */
  readonly unavailable: UnavailableSection[];
}

export const DEFAULT_SNAPSHOT_FACT_BUDGET = 150;

/**
 * A fact strong enough that dropping it would be dangerous: anything about
 * health, and any confirmed high-confidence rejection. Sorting these first is
 * what makes the budget safe, because the cap then only ever cuts into the
 * nuanced end of the list.
 */
function isStrong(fact: SnapshotFact): boolean {
  if (fact.category === "health") return true;
  return (
    fact.status === "confirmed" &&
    fact.polarity === "negative" &&
    fact.confidence === "high"
  );
}

const CONFIDENCE_RANK: Readonly<Record<string, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface RankedFact extends SnapshotFact {
  readonly lastReferencedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Selection when the facts exceed the budget: status first, then confidence,
 * then how recently the fact was referenced, exactly as the spec orders it,
 * with the dangerous ones pinned to the front.
 */
export function selectFactsForBudget(
  facts: readonly RankedFact[],
  budget: number,
): RankedFact[] {
  return [...facts]
    .sort((a, b) => {
      const strength = Number(isStrong(b)) - Number(isStrong(a));
      if (strength !== 0) return strength;

      const status =
        Number(a.status !== "confirmed") - Number(b.status !== "confirmed");
      if (status !== 0) return status;

      const confidence =
        (CONFIDENCE_RANK[a.confidence] ?? 3) -
        (CONFIDENCE_RANK[b.confidence] ?? 3);
      if (confidence !== 0) return confidence;

      const aSeen = a.lastReferencedAt?.getTime() ?? 0;
      const bSeen = b.lastReferencedAt?.getTime() ?? 0;
      if (aSeen !== bSeen) return bSeen - aSeen;

      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .slice(0, budget);
}

/**
 * Where each category lands in the nine sections. Every category has a home, so
 * no fact can be written and then silently never reach an agent.
 */
export function sectionOfFact(
  fact: SnapshotFact,
): "strong" | "kitchen" | "organization" | "taste" {
  if (isStrong(fact)) return "strong";
  if (fact.category === "equipment" || fact.category === "technique") {
    return "kitchen";
  }
  if (
    fact.category === "organization" ||
    fact.category === "pantry_habit" ||
    fact.category === "social"
  ) {
    return "organization";
  }
  return "taste";
}

/** Positive before negative, confirmed before unconfirmed, as specified. */
export function orderTasteFacts(facts: readonly SnapshotFact[]): SnapshotFact[] {
  const polarityRank: Record<string, number> = {
    positive: 0,
    neutral: 1,
    negative: 2,
  };
  return [...facts].sort((a, b) => {
    const polarity =
      (polarityRank[a.polarity] ?? 1) - (polarityRank[b.polarity] ?? 1);
    if (polarity !== 0) return polarity;
    return (
      Number(a.status !== "confirmed") - Number(b.status !== "confirmed")
    );
  });
}

const DIET_LABELS: Readonly<Record<string, string>> = {
  none: "aucun régime particulier",
  vegetarian: "végétarien",
  vegan: "végétalien",
  pescatarian: "pescétarien",
  halal: "halal",
  kosher: "casher",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  confirmed: "confirmé",
  unconfirmed: "non confirmé",
  retired: "retiré",
};

const CONFIDENCE_LABELS: Readonly<Record<string, string>> = {
  high: "confiance haute",
  medium: "confiance moyenne",
  low: "confiance faible",
};

/**
 * Markdown is the default rendering for MCP resource reads: it costs fewer
 * tokens than nested JSON and models follow prose constraints more reliably.
 */
export function renderSnapshotMarkdown(snapshot: ProfileSnapshot): string {
  const out: string[] = [];

  out.push("# Profil de cuisine");
  out.push("");
  out.push(
    `Document composé le ${snapshot.generatedAt}. Il contient ${plural(snapshot.factBudget.included, "fait", "faits")} sur ${plural(snapshot.factBudget.active, "actif", "actifs")} (plafond d'affichage : ${snapshot.factBudget.cap}).`,
  );
  if (snapshot.factBudget.included < snapshot.factBudget.active) {
    out.push(
      "Vous ne voyez donc pas tous les faits connus. Les faits confirmés, sûrs et récemment consultés sont retenus en priorité.",
    );
  }
  out.push("");

  out.push("## 1. Contraintes absolues");
  out.push("");
  if (snapshot.hardConstraints.strictAllergens.length > 0) {
    out.push(
      "**Ne proposez jamais** une recette contenant l'un de ces allergènes. C'est un blocage absolu, sans exception et sans dérogation possible :",
    );
    for (const allergen of snapshot.hardConstraints.strictAllergens) {
      const matches =
        allergen.matches.length > 0
          ? ` (déclenché par : ${allergen.matches.join(", ")})`
          : "";
      out.push(`- **${allergen.name}**${matches}`);
    }
  } else {
    out.push("Aucun allergène strict déclaré.");
  }
  out.push("");
  out.push(
    `Régime : ${DIET_LABELS[snapshot.hardConstraints.diet] ?? snapshot.hardConstraints.diet}.`,
  );
  if (snapshot.hardConstraints.dietNotes) {
    out.push(`Précisions : ${snapshot.hardConstraints.dietNotes}`);
  }
  out.push("");

  out.push("## 2. Préférences fortes");
  out.push("");
  if (snapshot.strongPreferences.avoidAllergens.length > 0) {
    out.push(
      `Allergènes à éviter, sans blocage strict : ${snapshot.strongPreferences.avoidAllergens
        .map((allergen) => allergen.name)
        .join(", ")}.`,
    );
  }
  if (snapshot.strongPreferences.exclusions.length > 0) {
    out.push(
      `Ingrédients refusés : ${snapshot.strongPreferences.exclusions
        .map((exclusion) => exclusion.name)
        .join(", ")}.`,
    );
  }
  pushFacts(out, snapshot.strongPreferences.facts);
  if (
    snapshot.strongPreferences.avoidAllergens.length === 0 &&
    snapshot.strongPreferences.exclusions.length === 0 &&
    snapshot.strongPreferences.facts.length === 0
  ) {
    out.push("Rien de signalé.");
  }
  out.push("");

  out.push("## 3. La forme de la semaine");
  out.push("");
  if (snapshot.weekShape.slots.length === 0) {
    out.push("Aucun créneau configuré.");
  } else {
    out.push(
      "Créneaux configurés. Un créneau `sauté` ne doit jamais être rempli, et le budget est en minutes de cuisine active :",
    );
    for (const slot of snapshot.weekShape.slots) {
      const budget =
        slot.timeBudgetMin === null
          ? "pas de budget"
          : `${slot.timeBudgetMin} min`;
      const servings =
        slot.defaultServings === null
          ? ""
          : `, ${slot.defaultServings} portions par défaut`;
      out.push(
        `- ${dayName(slot.dayOfWeek)} ${slot.mealTypeLabel.toLowerCase()} : ${translateSlotState(slot.state)}, ${budget}${servings}`,
      );
    }
  }
  out.push("");
  out.push(
    `Portions par défaut : ${snapshot.weekShape.defaultServings}. Budget de temps par défaut : ${
      snapshot.weekShape.defaultTimeBudgetMin === null
        ? "aucun"
        : `${snapshot.weekShape.defaultTimeBudgetMin} min`
    }. Tolérance de dépassement : ${snapshot.weekShape.timeBudgetToleranceMin} min, au-delà la proposition est refusée.`,
  );
  out.push(
    `Préférence de variété : ${snapshot.weekShape.varietyPreference} sur 5 (1 = la répétition convient, 5 = ne jamais répéter un plat).`,
  );
  out.push("");

  out.push("## 4. La cuisine");
  out.push("");
  out.push(`Niveau de cuisine : ${snapshot.kitchen.skillLevel} sur 5.`);
  out.push(
    snapshot.kitchen.equipment.length > 0
      ? `Équipement déclaré : ${snapshot.kitchen.equipment.join(", ")}.`
      : "Aucun équipement déclaré, ce qui ne veut pas dire qu'il n'y en a pas.",
  );
  pushFacts(out, snapshot.kitchen.facts);
  out.push("");

  out.push("## 5. Organisation");
  out.push("");
  if (snapshot.organizationFacts.length === 0) out.push("Rien de connu.");
  pushFacts(out, snapshot.organizationFacts);
  out.push("");

  out.push("## 6. Goûts");
  out.push("");
  if (snapshot.tasteFacts.length === 0) out.push("Rien de connu.");
  pushFacts(out, snapshot.tasteFacts);
  out.push("");

  if (snapshot.unavailable.length > 0) {
    out.push("## Sections non encore disponibles");
    out.push("");
    out.push(
      "Ces sections existent dans le modèle mais ne sont pas encore alimentées. Une section vide ici ne signifie pas « rien à signaler », mais « pas encore mesuré » :",
    );
    for (const section of snapshot.unavailable) {
      out.push(`- **${section.section}** : ${section.reason}`);
    }
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}

/**
 * French agreement, which starts at two rather than at one. The document is
 * read by a model but written for a person to check, and a sentence that reads
 * as machine output invites less scrutiny than one that does not.
 */
function plural(count: number, singular: string, many: string): string {
  return `${count} ${count >= 2 ? many : singular}`;
}

function pushFacts(out: string[], facts: readonly SnapshotFact[]): void {
  for (const fact of facts) {
    // Confidence and status inline, so the agent can discount an unconfirmed
    // low-confidence claim instead of treating every statement as equal.
    const source = fact.source === "agent" ? ", écrit par un agent" : "";
    out.push(
      `- ${fact.statement} (${CONFIDENCE_LABELS[fact.confidence] ?? fact.confidence}, ${STATUS_LABELS[fact.status] ?? fact.status}${source})`,
    );
  }
}

function translateSlotState(state: string): string {
  if (state === "planned") return "planifié";
  if (state === "skipped") return "sauté";
  return "masqué";
}

/** Slot definitions as the snapshot wants them: hidden slots are not news. */
export function snapshotSlots(
  slots: readonly SlotDefinition[],
): SnapshotSlot[] {
  return slots
    .filter((slot) => slot.state !== "hidden")
    .map((slot) => ({
      dayOfWeek: slot.dayOfWeek,
      mealTypeLabel: slot.mealTypeLabel,
      state: slot.state,
      timeBudgetMin: slot.timeBudgetMin,
      defaultServings: slot.defaultServings,
    }));
}
