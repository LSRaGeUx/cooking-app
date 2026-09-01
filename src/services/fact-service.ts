import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { fact } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import {
  factFilterSchema,
  factInputSchema,
  factMetadataSchema,
} from "@/domain/schemas";
import { DEFAULT_FACT_CAP, type FactStatus } from "@/domain/vocabulary";
import { inScope, type ServiceContext } from "./context";

/**
 * The fact store.
 *
 * Two rules govern every write here, and both exist because this table is the
 * product's moat and poisoning it is the top product risk:
 *
 * 1. **An agent's fact enters unconfirmed, whatever it asked for.** The server
 *    overrides the status rather than validating it, so there is no payload an
 *    agent can send that confirms its own claim.
 * 2. **Meaning is never rewritten in place.** Changing what a fact says means
 *    retiring it and inserting a replacement that points back at it, because
 *    "used to hate mushrooms, now eats them" is signal and an UPDATE destroys
 *    it. Only the filing (category) and the certainty (confidence) can move.
 */

export interface FactView {
  readonly id: string;
  readonly category: string;
  readonly statement: string;
  readonly polarity: string;
  readonly confidence: string;
  readonly source: string;
  readonly sourceClientId: string | null;
  readonly status: string;
  readonly supersedesId: string | null;
  readonly evidence: string[];
  readonly createdAt: Date;
  readonly lastReferencedAt: Date | null;
  readonly retiredAt: Date | null;
}

export async function listFacts(
  ctx: ServiceContext,
  filter: unknown = {},
): Promise<FactView[]> {
  const parsed = factFilterSchema.parse(filter);

  return inScope(ctx, async (tx) => {
    const conditions = [eq(fact.userId, ctx.userId)];
    if (parsed.status) conditions.push(eq(fact.status, parsed.status));
    else if (!parsed.includeRetired) conditions.push(ne(fact.status, "retired"));
    if (parsed.category) conditions.push(eq(fact.category, parsed.category));
    if (parsed.polarity) conditions.push(eq(fact.polarity, parsed.polarity));

    const rows = await tx
      .select()
      .from(fact)
      .where(and(...conditions))
      // Unconfirmed first: this screen is the trust surface, and the agent's
      // unreviewed claims are what the user came to review.
      .orderBy(
        sql`case ${fact.status} when 'unconfirmed' then 0 when 'confirmed' then 1 else 2 end`,
        desc(fact.createdAt),
      );

    return rows.map(toFactView);
  });
}

export async function countActiveFacts(ctx: ServiceContext): Promise<number> {
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(fact)
      .where(and(eq(fact.userId, ctx.userId), ne(fact.status, "retired")));
    return rows[0]?.total ?? 0;
  });
}

/**
 * The facts to prune first when the cap is reached: unreviewed claims that
 * nothing has looked at in a long time. Offered in the error an agent gets, so
 * a rejected write comes with the fix attached.
 */
export async function retirementCandidates(
  ctx: ServiceContext,
  limit = 5,
): Promise<FactView[]> {
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(fact)
      .where(and(eq(fact.userId, ctx.userId), eq(fact.status, "unconfirmed")))
      .orderBy(
        // Never referenced sorts before referenced long ago.
        sql`${fact.lastReferencedAt} asc nulls first`,
        asc(fact.createdAt),
      )
      .limit(limit);
    return rows.map(toFactView);
  });
}

export async function createFact(
  ctx: ServiceContext,
  input: unknown,
  options: { cap?: number } = {},
): Promise<FactView> {
  const parsed = factInputSchema.parse(input);
  const cap = options.cap ?? DEFAULT_FACT_CAP;

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    await assertUnderCap(scoped, cap);

    const rows = await tx
      .insert(fact)
      .values({
        userId: ctx.userId,
        category: parsed.category,
        statement: parsed.statement,
        polarity: parsed.polarity,
        confidence: parsed.confidence,
        evidence: parsed.evidence,
        source: ctx.actor === "agent" ? "agent" : "user",
        sourceClientId: ctx.actor === "agent" ? (ctx.clientId ?? null) : null,
        // Not negotiable and not read from the payload: only a human confirms.
        status: ctx.actor === "agent" ? "unconfirmed" : "confirmed",
      })
      .returning();

    return toFactView(rows[0]!);
  });
}

/**
 * Only a human. An agent confirming its own facts would make the review surface
 * decorative, so there is no code path for it: the caller's actor decides.
 */
export async function confirmFact(
  ctx: ServiceContext,
  factId: string,
): Promise<FactView> {
  if (ctx.actor !== "user") {
    throw new DomainError(
      "FORBIDDEN",
      "Un agent ne peut pas confirmer un fait. Seule une personne confirme ce qui est vrai à son sujet ; le fait reste visible et influence la planification en attendant.",
      { factId },
    );
  }

  return inScope(ctx, async (tx) => {
    const rows = await tx
      .update(fact)
      .set({ status: "confirmed" })
      .where(and(eq(fact.id, factId), ne(fact.status, "retired")))
      .returning();
    if (!rows[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce fait n'existe pas ou est déjà retiré.",
        { factId },
      );
    }
    return toFactView(rows[0]);
  });
}

export async function updateFactMetadata(
  ctx: ServiceContext,
  factId: string,
  changes: unknown,
): Promise<FactView> {
  const parsed = factMetadataSchema.parse(changes);
  if (parsed.category === undefined && parsed.confidence === undefined) {
    throw new DomainError(
      "VALIDATION",
      "Rien à modifier. Seules la catégorie et la confiance se modifient sur place ; changer l'énoncé d'un fait passe par un remplacement, qui conserve l'historique.",
      { factId },
    );
  }

  return inScope(ctx, async (tx) => {
    const rows = await tx
      .update(fact)
      .set(parsed)
      .where(and(eq(fact.id, factId), ne(fact.status, "retired")))
      .returning();
    if (!rows[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce fait n'existe pas ou est déjà retiré.",
        { factId },
      );
    }
    return toFactView(rows[0]);
  });
}

export async function retireFact(
  ctx: ServiceContext,
  factId: string,
): Promise<FactView> {
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .update(fact)
      .set({ status: "retired", retiredAt: new Date() })
      .where(and(eq(fact.id, factId), ne(fact.status, "retired")))
      .returning();
    if (!rows[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce fait n'existe pas ou est déjà retiré.",
        { factId },
      );
    }
    return toFactView(rows[0]);
  });
}

export interface SupersedeResult {
  readonly retired: FactView;
  readonly created: FactView;
}

/**
 * How a contradiction is resolved: the old fact is retired, the new one records
 * what it replaced. Both rows survive, so the history of a changing taste stays
 * readable.
 *
 * Retiring does not count against the cap check, because a supersede replaces
 * rather than adds.
 */
export async function supersedeFact(
  ctx: ServiceContext,
  factId: string,
  input: unknown,
  options: { cap?: number } = {},
): Promise<SupersedeResult> {
  const parsed = factInputSchema.parse(input);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const retired = await retireFact(scoped, factId);

    const rows = await tx
      .insert(fact)
      .values({
        userId: ctx.userId,
        category: parsed.category,
        statement: parsed.statement,
        polarity: parsed.polarity,
        confidence: parsed.confidence,
        evidence: parsed.evidence,
        source: ctx.actor === "agent" ? "agent" : "user",
        sourceClientId: ctx.actor === "agent" ? (ctx.clientId ?? null) : null,
        status: ctx.actor === "agent" ? "unconfirmed" : "confirmed",
        supersedesId: retired.id,
      })
      .returning();

    // The cap is checked after the swap, so replacing a fact at the cap works
    // while adding one past it does not.
    await assertUnderCap(scoped, options.cap ?? DEFAULT_FACT_CAP, 0);

    return { retired, created: toFactView(rows[0]!) };
  });
}

/**
 * Records that these facts were handed to an agent, which is what the pruning
 * heuristic reads. Called by the snapshot composer.
 */
export async function markFactsReferenced(
  ctx: ServiceContext,
  factIds: readonly string[],
): Promise<void> {
  if (factIds.length === 0) return;
  await inScope(ctx, async (tx) => {
    await tx
      .update(fact)
      .set({ lastReferencedAt: new Date() })
      .where(
        and(
          eq(fact.userId, ctx.userId),
          sql`${fact.id} = any(${sql.param(factIds)}::uuid[])`,
        ),
      );
  });
}

async function assertUnderCap(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  cap: number,
  headroom = 1,
): Promise<void> {
  const active = await countActiveFacts(ctx);
  if (active + headroom <= cap) return;

  const candidates = await retirementCandidates(ctx, 5);
  throw new DomainError(
    "FACT_CAP_REACHED",
    `Vous avez ${active} faits actifs pour un plafond de ${cap}. Retirez d'abord un fait devenu inutile. Les moins consultés et non confirmés sont : ${
      candidates.map((row) => `« ${row.statement} »`).join(", ") || "aucun"
    }.`,
    {
      active,
      cap,
      candidates: candidates.map((row) => ({
        id: row.id,
        statement: row.statement,
        lastReferencedAt: row.lastReferencedAt,
      })),
    },
  );
}

function toFactView(row: typeof fact.$inferSelect): FactView {
  return {
    id: row.id,
    category: row.category,
    statement: row.statement,
    polarity: row.polarity,
    confidence: row.confidence,
    source: row.source,
    sourceClientId: row.sourceClientId,
    status: row.status as FactStatus,
    supersedesId: row.supersedesId,
    evidence: Array.isArray(row.evidence) ? (row.evidence as string[]) : [],
    createdAt: row.createdAt,
    lastReferencedAt: row.lastReferencedAt,
    retiredAt: row.retiredAt,
  };
}
