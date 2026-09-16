import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

/**
 * One vitest run for the whole monorepo. Tests live in each package's
 * `tests/` directory (outside `src/`, so they are never compiled into
 * `dist/` or shipped). The repo-level `tests/` directory holds the few
 * tests that belong to no package because their subject is the repo's own
 * wiring — the release workflow, for instance.
 *
 * The swc plugin is required by the TypeORM / NestJS projects: vitest's
 * default esbuild transform cannot emit decorator metadata, which TypeORM
 * entities and Nest DI rely on. Core is plain TypeScript and would not
 * need it, but one uniform transform keeps behavior identical everywhere.
 */
const swcPlugin = swc.vite({
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: "es2022",
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  resolve: {
    // Tests exercise workspace sources directly — no stale-dist hazard.
    alias: {
      "@kavo/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@kavo/typeorm": new URL("./packages/orms/typeorm/src/index.ts", import.meta.url).pathname,
      "@kavo/prisma": new URL("./packages/orms/prisma/src/index.ts", import.meta.url).pathname,
      "@kavo/mongoose": new URL("./packages/orms/mongoose/src/index.ts", import.meta.url).pathname,
      "@kavo/mikroorm": new URL("./packages/orms/mikroorm/src/index.ts", import.meta.url).pathname,
      "@kavo/sse": new URL("./packages/realtime/sse/src/index.ts", import.meta.url).pathname,
      "@kavo/nest": new URL("./packages/frameworks/nest/src/index.ts", import.meta.url).pathname,
      "@kavo/next": new URL("./packages/frameworks/next/src/index.ts", import.meta.url).pathname,
      "@kavo/graphql": new URL("./packages/protocols/graphql/src/index.ts", import.meta.url).pathname,
      "@kavo/mcp": new URL("./packages/protocols/mcp/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["packages/**/tests/**/*.spec.ts", "examples/**/tests/**/*.spec.ts", "tests/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    testTimeout: 30_000,
    // @kavo/prisma's specs each get their own copy of the pushed SQLite
    // fixture, so parallel workers never contend for one file (issue #101).
    // examples/next-prisma's specs do the same over its own fixture db.
    // Only the main process can clean those copies up — vitest kills workers.
    globalSetup: [
      "./packages/orms/prisma/tests/support/global-setup.ts",
      "./examples/next-prisma/tests/support/global-setup.ts",
    ],
  },
});
