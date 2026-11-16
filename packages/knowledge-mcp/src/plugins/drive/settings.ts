/**
 * Drive indexing scope and limits. Only lightweight constants live here. They are kept separate so the tools do not
 * load the whole indexer (indexer.ts, tokenizer, Qdrant) just for these values.
 */
import { getConfig } from '../../core/config.js';
import { isTrusted } from './trust.js';

/** Drive index roots (SSOT for full reindex + incremental sync). Configured via config.drive.roots. */
export const DRIVE_ROOTS = getConfig().drive.roots;

/**
 * Whether documents shared with the service account outside the roots are visible (config drive.scope, env DRIVE_SCOPE).
 * Read on every call so an env change needs no code change to roll back.
 */
export function sharedScopeEnabled(): boolean {
  const v = process.env.DRIVE_SCOPE?.trim().toLowerCase();
  if (v === 'roots' || v === 'shared') return v === 'shared';
  return getConfig().drive.scope === 'shared';
}

/** drive.trustedOwners, lowercased. env DRIVE_TRUSTED_OWNERS (comma-separated) takes precedence. */
export function trustedOwners(): string[] {
  const env = process.env.DRIVE_TRUSTED_OWNERS;
  const list = env !== undefined ? env.split(',') : getConfig().drive.trustedOwners;
  return list.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * May a document shared outside the roots be shown? Decided on the top shared item (the file that was shared, or
 * the top folder of a shared folder): its owner, or its shared drive, must be in drive.trustedOwners.
 * Why: sharing with a service account needs no acceptance, so without this check anyone who knows the address
 * could plant a document in every user's search results.
 */
export function isTrustedShare(owners: string[] | undefined, driveId?: string | null): boolean {
  return isTrusted(trustedOwners(), owners, driveId);
}

/** `source` label for documents shared outside the roots (config drive.sharedSource). */
export const SHARED_SOURCE = getConfig().drive.sharedSource;

/** Every `source` label an indexed chunk can carry: the roots' labels, plus the shared label when it is in scope. */
export function sourceLabels(): string[] {
  const labels = new Set(DRIVE_ROOTS.map((r) => r.source));
  if (sharedScopeEnabled()) labels.add(SHARED_SOURCE);
  return [...labels];
}

/**
 * Does this source take its metadata from the path (category, customer, tags from folder and file names) rather
 * than from Markdown frontmatter? Set per root with `metadata`. Without it: "dev" means frontmatter (the 0.3
 * meaning), anything else means path.
 */
export function usesPathMetadata(source: string): boolean {
  const root = DRIVE_ROOTS.find((r) => r.source === source && r.metadata);
  if (root?.metadata) return root.metadata === 'path';
  return source !== 'dev';
}

/**
 * File size cap (bytes) for indexing and reading. A file is loaded into memory whole, so this stops one huge file from
 * crashing the server. Google Docs, Sheets and Slides have no size in the Drive metadata (they are exported), so they
 * are not subject to this check.
 */
export const MAX_FILE_BYTES = Number(process.env.DRIVE_MAX_FILE_BYTES ?? 50_000_000);
