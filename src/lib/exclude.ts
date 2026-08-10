/**
 * Search-index folder exclusions — single source of truth.
 *
 * Shared by full reindex (scripts/index_drive) and incremental sync (lib/drive_sync). Two buckets:
 *   1. Built-in dev artifacts (node_modules, .git, build outputs) — always excluded so whole code
 *      projects in Drive don't flood the index with library-doc noise.
 *   2. Configured sensitive folders (config.drive.excludeFolders) — your PII/contract/HR/backup folders.
 */
import { getConfig } from './config.js';

const BUILTIN_EXCLUDES = [
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'coverage', '.cache', '.turbo', '.parcel-cache',
  '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache',
];

/** Merged exclusion set: built-in dev artifacts + configured sensitive folders. */
export const EXCLUDED_FOLDER_NAMES = new Set<string>([
  ...BUILTIN_EXCLUDES,
  ...getConfig().drive.excludeFolders,
]);

/**
 * True if any path segment exactly matches an excluded folder name.
 * Segment-wise (not includes()) so e.g. "rebuild.md" doesn't match "build".
 */
export function isExcludedPath(path: string): boolean {
  return path.split('/').some((seg) => EXCLUDED_FOLDER_NAMES.has(seg));
}
