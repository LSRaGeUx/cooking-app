/**
 * Drizzle owns the domain tables only. Better Auth owns its 12 tables and
 * migrates them with its own migrator, so nothing here describes them. See
 * docs/07-phase-0-findings.md section 3.1.
 */
export * from "./_shared";
export * from "./activity";
export * from "./profile";
export * from "./facts";
export * from "./slots";
export * from "./recipes";
export * from "./plans";
export * from "./feedback";
export * from "./grocery";
