// Hand-written because the module is plain JavaScript on purpose: the setup and
// bootstrap scripts run under bare `node`, before any TypeScript loader exists.
// The Vitest setup files are TypeScript and import it, so it needs a shape.

import type { Client } from "pg";

/** The databases that sit beside the development one. */
export type SiblingKind = "test" | "verify";

export const SIBLING_KINDS: readonly SiblingKind[];

/** The development URL with this sibling's suffix appended to the name. */
export function deriveSiblingUrl(url: string, kind: SiblingKind): string;

/** The database name a connection URL points at, percent-decoded. */
export function databaseNameOf(url: string): string;

/** The password node-postgres will connect with, percent-decoded like it does. */
export function passwordOf(url: string): string;

/** The same URL with its credential replaced, safe to print in an error. */
export function redactUrl(url: string): string;

/** Owner and runtime URLs for one sibling, honouring its overrides. */
export function siblingUrls(
  kind: SiblingKind,
  env?: NodeJS.ProcessEnv,
): { readonly owner: string; readonly app: string };

/**
 * Throws unless both URLs name one database of this sibling's own, carrying its
 * suffix. Returns that name.
 */
export function assertSiblingUrls(
  kind: SiblingKind,
  urls: { readonly owner: string; readonly app: string },
  env?: NodeJS.ProcessEnv,
): string;

/** The npm script that creates and migrates one sibling. */
export function setupCommandFor(kind: SiblingKind): string;

/** A connection to another database on the same instance, for CREATE DATABASE. */
export function adminUrlFor(
  url: string,
  kind: SiblingKind,
  fallback?: string,
): string;

/** Creates the database if it is absent. Reports which of the two happened. */
export function ensureDatabase(
  adminUrl: string,
  name: string,
): Promise<"created" | "present">;

/**
 * Creates the least-privileged runtime role and its grants. Idempotent, but it
 * also re-applies the cluster-wide password, so pass the application's own.
 */
export function applyBootstrap(
  ownerUrl: string,
  appPassword: string,
): Promise<void>;

/** Connects, turning a missing database into advice rather than a 3D000. */
export function connectChecked(
  ownerUrl: string,
  name: string,
  setupCommand: string,
): Promise<Client>;

/** Throws, naming the setup command, when the schema is behind the migrations. */
export function assertMigrationsApplied(
  client: Client,
  name: string,
  setupCommand: string,
): Promise<void>;

/** Connect, check the schema, disconnect. */
export function assertDatabaseReady(
  ownerUrl: string,
  name: string,
  setupCommand: string,
): Promise<void>;

/** Empties every table in `public`, schema-qualified and privilege-filtered. */
export function truncatePublicTables(
  ownerUrl: string,
  name: string,
  setupCommand: string,
): Promise<void>;
