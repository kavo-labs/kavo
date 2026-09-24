// Types for scripts/build-docs7.mjs, so tests/docs7-sync.spec.ts type-checks
// against it (the repo does not enable `allowJs`).

/** Converts one VitePress page (`rel` is its path under `docs/`) to Docs7 MDX. Throws on anything it cannot translate. */
export function convertPage(source: string, rel: string): string;

/** Regenerates the whole Docs7 tree into `outDir`, replacing whatever is there. */
export function buildDocs7(outDir: string): void;

/** Files that differ between a freshly generated tree and the committed one, as `missing:`/`stale:`/`extra:` lines. */
export function diffTrees(expected: string, actual: string): string[];
