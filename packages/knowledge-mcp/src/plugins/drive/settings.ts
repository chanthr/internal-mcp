/**
 * Drive indexing scope and limits. Only lightweight constants live here. They are kept separate so the tools do not
 * load the whole indexer (indexer.ts, tokenizer, Qdrant) just for these values.
 */
import { getConfig } from '../../core/config.js';

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
