import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { fact } from "@/db/schema";
import { firstRow } from "@/db/rows";
import { DomainError } from "@/domain/errors";
import {
  factFilterSchema,
  factInputSchema,
  factMetadataSchema,
  type FactInput,
} from "@/domain/schemas";
import {
  DEFAULT_FACT_CAP,
  type FactCategory,
  type FactConfidence,
  type FactPolarity,
  type FactSource,
  type FactStatus,
} from "@/domain/vocabulary";
import { inScope, type ScopedContext, type ServiceContext } from "./context";

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
 *
 * A third rule follows from rule 6 of CLAUDE.md and is enforced below: an agent
 * may retire only what an agent could have been wrong about. A fact a human
 * confirmed is theirs, and an agent that could retire it could quietly empty
 * the store one call at a time.
 */

export interface FactView {
  readonly id: string;
  /**
   * The vocabulary unions rather than `string`. Every one of these columns is
   * `text` plus a check constraint, so a widened type let a reader compare
   * against a value the database cannot hold and let a label lookup miss.
   */
  readonly category: FactCategory;
  readonly statement: string;
  readonly polarity: FactPolarity;
  readonly confidence: FactConfidence;
  readonly source: FactSource;
  readonly sourceClientId: string | null;
  readonly status: FactStatus;
  readonly supersedesId: string | null;
  readonly evidence: string[];
  readonly createdAt: Date;
  readonly lastReferencedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly retirementReason: string | null;
}

export async function listFacts(
  ctx: ServiceContext,
  filter: unknown = {},
): Promise<FactView[]> {
  const parsed = factFilterSchema.parse(filter);

  return inScope(ctx, async ({ tx }) => {
    const conditions = [eq(fact.userId, ctx.userId)];
    if (parsed.status) conditions.push(eq(fact.status, parsed.status));
    else if (!parsed.includeRetired)
      conditions.push(ne(fact.status, "retired"));
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
  return inScope(ctx, async ({ tx }) => {
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
  return inScope(ctx, async ({ tx }) => {
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
  return firstRow(await createFacts(ctx, [input], options), "fact insert");
}

/**
 * Several facts, one transaction.
 *
 * The agent surface writes facts in batches, and it used to do that by calling
 * `createFact` in a loop: the cap was then checked per call, so a batch of five
 * that breached it on the fifth left the first four written and reported a
 * failure. The caller had no way to tell which had landed. Inside one `inScope`
 * a `FACT_CAP_REACHED` rolls the whole batch back, and the cap counts the batch
 * rather than one row at a time, so a batch of ten with five slots left is
 * refused instead of half applied.
 */
export async function createFacts(
  ctx: ServiceContext,
  inputs: readonly unknown[],
  options: { cap?: number } = {},
): Promise<FactView[]> {
  const parsed: FactInput[] = inputs.map((input) =>
    factInputSchema.parse(input),
  );
  if (parsed.length === 0) return [];
  const cap = options.cap ?? DEFAULT_FACT_CAP;

  return inScope(ctx, async (scoped) => {
    await assertUnderCap(scoped, cap, parsed.length);

    const rows = await scoped.tx
      .insert(fact)
      .values(
        parsed.map((row) => ({
          userId: ctx.userId,
          category: row.category,
          statement: row.statement,
          polarity: row.polarity,
          confidence: row.confidence,
          evidence: row.evidence,
          source:
            ctx.actor === "agent" ? ("agent" as const) : ("user" as const),
          sourceClientId: ctx.actor === "agent" ? (ctx.clientId ?? null) : null,
          // Not negotiable and not read from the payload: only a human
          // confirms.
          status:
            ctx.actor === "agent"
              ? ("unconfirmed" as const)
              : ("confirmed" as const),
        })),
      )
      .returning();

    return rows.map(toFactView);
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

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(fact)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(fact.id, factId),
          eq(fact.userId, ctx.userId),
          ne(fact.status, "retired"),
        ),
      )
      .returning();
    const [row] = rows;
    if (!row) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce fait n'existe pas ou est déjà retiré.",
        { factId },
      );
    }
    return toFactView(row);
  });
}

/**
 * Category and confidence, the two things that can move without changing what a
 * fact means.
 *
 * Confidence is gated on the actor for confirmed facts, and that is not tidiness
 * either. `status` was guarded and `confidence` was not, so an agent could take
 * a claim a human had confirmed and raise it to `high`, which is the same
 * escalation as writing a confirmed fact, reached through the one field nobody
 * was watching. An agent may still adjust its own unconfirmed claims, which is
 * the case the field exists for.
 */
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

  return inScope(ctx, async (scoped) => {
    const existing = await requireLiveFact(scoped, factId);

    if (
      parsed.confidence !== undefined &&
      ctx.actor !== "user" &&
      existing.status === "confirmed"
    ) {
      throw new DomainError(
        "FORBIDDEN",
        "Un agent ne peut pas modifier la confiance d'un fait confirmé par la personne concernée. Proposez un remplacement avec `supersede_fact` si votre lecture a changé : il conserve les deux versions et laisse la personne trancher.",
        { factId, status: existing.status },
      );
    }

    const rows = await scoped.tx
      .update(fact)
      .set(parsed)
      .where(and(eq(fact.id, factId), eq(fact.userId, ctx.userId)))
      .returning();
    return toFactView(firstRow(rows, "fact metadata update"));
  });
}

/**
 * Retiring a fact, which is how anything leaves the store: the row survives,
 * `retired_at` is set, and `restoreFact` can bring it back.
 *
 * An agent may retire only an unconfirmed fact or one an agent wrote. Anything
 * else is a claim a person made about themselves, and an agent that could
 * retire those could empty the store one call at a time with nothing in the
 * product to reverse it, which is exactly what rule 6 is about.
 */
export async function retireFact(
  ctx: ServiceContext,
  factId: string,
  reason?: string | null,
): Promise<FactView> {
  return inScope(ctx, async (scoped) => {
    const existing = await requireLiveFact(scoped, factId);
    assertMayRetire(ctx, existing);
    return retireRow(scoped, factId, reason);
  });
}

/**
 * Un-retires a fact.
 *
 * Rule 6 promises that nothing an agent does is irreversible, and retirement
 * was the one agent-reachable write with no way back from the product: the row
 * was still there, and nothing could clear `retired_at`. The check constraint
 * `fact_retired_at_matches_status` already allowed this transition, so the only
 * thing missing was the path.
 *
 * The fact comes back `unconfirmed` rather than to whatever it was before.
 * Nothing records the status it held, and guessing `confirmed` would let a
 * retire-then-restore pair conjure a confirmation no human gave.
 */
export async function restoreFact(
  ctx: ServiceContext,
  id: string,
): Promise<FactView> {
  return inScope(ctx, async (scoped) => {
    await assertUnderCap(scoped, DEFAULT_FACT_CAP, 1);

    const rows = await scoped.tx
      .update(fact)
      .set({
        status: "unconfirmed",
        retiredAt: null,
        retirementReason: null,
      })
      .where(
        and(
          eq(fact.id, id),
          eq(fact.userId, ctx.userId),
          eq(fact.status, "retired"),
        ),
      )
      .returning();
    const [row] = rows;
    if (!row) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce fait n'existe pas ou n'est pas retiré. Un fait actif n'a pas besoin d'être restauré.",
        { factId: id },
      );
    }
    return toFactView(row);
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
 *
 * **This is the one path by which an agent may retire a confirmed fact,** and
 * that is deliberate rather than an oversight in the guard on `retireFact`.
 * Nothing is lost: the old row stays, the new one points back at it through
 * `supersedes_id`, and the replacement enters `unconfirmed` like any other
 * agent-written claim, so the user sees the contradiction on the review surface
 * and can restore the old fact. A bare retirement offers none of that, which is
 * why it is refused and this is not.
 */
export async function supersedeFact(
  ctx: ServiceContext,
  factId: string,
  input: unknown,
  options: { cap?: number } = {},
): Promise<SupersedeResult> {
  const parsed = factInputSchema.parse(input);

  return inScope(ctx, async (scoped) => {
    await requireLiveFact(scoped, factId);
    const retired = await retireRow(scoped, factId, null);

    const rows = await scoped.tx
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

    return { retired, created: toFactView(firstRow(rows, "fact supersede")) };
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
  await inScope(ctx, async ({ tx }) => {
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

/**
 * The retirement itself, with no actor check. `retireFact` guards it and
 * `supersedeFact` deliberately does not, for the reason on that function.
 */
async function retireRow(
  ctx: ScopedContext,
  factId: string,
  reason: string | null | undefined,
): Promise<FactView> {
  const rows = await ctx.tx
    .update(fact)
    .set({
      status: "retired",
      retiredAt: new Date(),
      retirementReason: reason?.trim() ? reason.trim() : null,
    })
    .where(and(eq(fact.id, factId), eq(fact.userId, ctx.userId)))
    .returning();
  return toFactView(firstRow(rows, "fact retirement"));
}

/** The fact as stored, or NOT_FOUND. Live means "not retired". */
async function requireLiveFact(
  ctx: ScopedContext,
  factId: string,
): Promise<typeof fact.$inferSelect> {
  const rows = await ctx.tx
    .select()
    .from(fact)
    .where(
      and(
        eq(fact.id, factId),
        eq(fact.userId, ctx.userId),
        ne(fact.status, "retired"),
      ),
    )
    .limit(1);
  const [row] = rows;
  if (!row) {
    throw new DomainError(
      "NOT_FOUND",
      "Ce fait n'existe pas ou est déjà retiré.",
      { factId },
    );
  }
  return row;
}

function assertMayRetire(
  ctx: ServiceContext,
  row: typeof fact.$inferSelect,
): void {
  if (ctx.actor === "user") return;
  if (row.status === "unconfirmed" || row.source === "agent") return;

  throw new DomainError(
    "FORBIDDEN",
    "Un agent ne peut retirer qu'un fait non confirmé ou un fait écrit par un agent. Celui-ci a été confirmé par la personne concernée : proposez un remplacement avec `supersede_fact`, qui conserve les deux versions et laisse la personne trancher.",
    { factId: row.id, status: row.status, source: row.source },
  );
}

/**
 * Refuses a write that would take the user past the cap.
 *
 * Counting and then inserting is a race: two agent calls arriving together both
 * read a count under the cap and both insert, and the cap is exactly the kind
 * of limit that is worthless if it can be walked past by calling twice.
 *
 * A row lock cannot fix it, which is worth stating because it is the obvious
 * first attempt. `for update` on the live facts locks the rows that exist, and
 * the row the other transaction is about to insert is not one of them: under
 * read committed it is not in either snapshot, so both counts come back the
 * same and both inserts land. What is needed is a lock on the *user*, not on
 * their rows, and an advisory lock is that: keyed on the user id, held until
 * the transaction ends, taken by every path that writes a fact. Two concurrent
 * agent writes for one account queue; two for different accounts do not, unless
 * `hashtext` collides, which costs a wait and nothing else.
 */
async function assertUnderCap(
  ctx: ScopedContext,
  cap: number,
  headroom = 1,
): Promise<void> {
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`cooking.fact_cap:${ctx.userId}`}))`,
  );

  const active = await countActiveFacts(ctx);
  if (active + headroom <= cap) return;

  const candidates = await retirementCandidates(ctx, 5);
  throw new DomainError(
    "FACT_CAP_REACHED",
    `Vous avez ${active} faits actifs pour un plafond de ${cap}, et cet appel en ajouterait ${headroom}. Retirez d'abord un fait devenu inutile. Les moins consultés et non confirmés sont : ${
      candidates.map((row) => `« ${row.statement} »`).join(", ") || "aucun"
    }.`,
    {
      active,
      cap,
      requested: headroom,
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
    // The enum-like columns are `text` plus a check constraint, so Drizzle
    // types them `string`. Narrowed here, at the single row-to-view boundary.
    category: row.category as FactCategory,
    statement: row.statement,
    polarity: row.polarity as FactPolarity,
    confidence: row.confidence as FactConfidence,
    source: row.source as FactSource,
    sourceClientId: row.sourceClientId,
    status: row.status as FactStatus,
    supersedesId: row.supersedesId,
    // `not null default '[]'::jsonb` and `$type<string[]>()`, so the column
    // hands back an array and the old `Array.isArray` guard and cast are gone.
    evidence: row.evidence,
    createdAt: row.createdAt,
    lastReferencedAt: row.lastReferencedAt,
    retiredAt: row.retiredAt,
    retirementReason: row.retirementReason,
  };
}
