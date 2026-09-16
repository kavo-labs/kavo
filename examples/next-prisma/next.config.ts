import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This repo is a worktree nested under another checkout of the same
  // monorepo, so Next's own lockfile-based root inference finds two
  // pnpm-lock.yaml files and picks the wrong one. Pinning it to this
  // package's own directory is what a plain (non-worktree) checkout would
  // have inferred on its own.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
};

export default nextConfig;
