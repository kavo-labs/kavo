import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

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
    alias: {
      "@kavo/core": new URL("../../packages/core/src/index.ts", import.meta.url).pathname,
      "@kavo/typeorm": new URL("../../packages/orms/typeorm/src/index.ts", import.meta.url).pathname,
      "@kavo/nest": new URL("../../packages/frameworks/nest/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["engine/**/*.bench.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    benchmark: {
      reporters: ["default"],
    },
  },
});
