import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where `tests/support/db.ts` puts the per-client SQLite copies it
 * provisions — the same scratch-root pattern `@kavo/prisma`'s own test
 * suite uses for the identical problem (`packages/orms/prisma/tests/support/global-setup.ts`).
 * A distinct env var, so the two roots never collide even though both
 * packages' tests run under one shared vitest invocation.
 */
export const SCRATCH_ROOT_ENV = "KAVO_NEXT_PRISMA_SCRATCH_ROOT";

/**
 * One scratch root per vitest run, removed when the run ends — teardown has
 * to happen here, in the main process, because vitest kills its workers and
 * a per-copy `process.on("exit")` handler inside one never runs.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "kavo-next-prisma-"));
  process.env[SCRATCH_ROOT_ENV] = root;

  return () => {
    delete process.env[SCRATCH_ROOT_ENV];
    rmSync(root, { recursive: true, force: true });
  };
}
