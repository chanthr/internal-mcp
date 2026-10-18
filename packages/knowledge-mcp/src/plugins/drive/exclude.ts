/**
 * Search-index folder exclusions — single source of truth.
 *
 * Shared by full reindex (reindex.ts), incremental sync (sync.ts) and the read/list/search
 * tools (path.ts). Two buckets:
 *   1. Built-in dev artifacts (node_modules, .git, build outputs) — always excluded so whole code
 *      projects in Drive don't flood the index with library-doc noise.
 *   2. Configured sensitive folders (config.drive.excludeFolders) — your PII/contract/HR/backup folders.
 *
 * Names are compared after normalization (Unicode NFC, trimmed, lower-cased). Drive keeps whatever form the
 * uploader sent, so a macOS-uploaded Korean folder name can arrive as NFD and "HR " or "hr" must still match.
 */
import { getConfig } from '../../core/config.js';

const BUILTIN_EXCLUDES = [
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'coverage', '.cache', '.turbo', '.parcel-cache',
  '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache',
];

/** Normalized form used for every exclusion comparison. */
export function normalizeFolderName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** Merged exclusion set (normalized): built-in dev artifacts + configured sensitive folders. */
export const EXCLUDED_FOLDER_NAMES = new Set<string>(
  [...BUILTIN_EXCLUDES, ...getConfig().drive.excludeFolders].map(normalizeFolderName),
);

/** True if this single folder name is excluded. */
export function isExcludedName(name: string | null | undefined): boolean {
  return !!name && EXCLUDED_FOLDER_NAMES.has(normalizeFolderName(name));
}

/**
 * True if any path segment matches an excluded folder name.
 * Segment-wise (not includes()) so e.g. "rebuild.md" doesn't match "build".
 */
export function isExcludedPath(path: string): boolean {
  return path.split('/').some((seg) => isExcludedName(seg));
}
