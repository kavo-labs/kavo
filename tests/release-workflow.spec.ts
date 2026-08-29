import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The release pipeline, as a set of assertions.
 *
 * ADR-0004 says every `@kavo/*` package ships on one version, but until now
 * nothing enforced it: `publish.yml` compared the tag against `@kavo/core`
 * alone, so a package left behind packed stale and was then skipped by the
 * already-published guard — a green release that shipped one package short.
 * That is not a hypothetical; it is how v0.6.0 left `@kavo/prisma` at 0.5.0.
 *
 * These tests cover three things: the state of the tree itself, the behavior
 * of the gate script, and the workflow wiring that decides when the gate runs
 * and in what order packages go out. The wiring part deliberately reads
 * `publish.yml` as text — the file is the artifact under test, and a test that
 * reimplemented its contents would pass while the real pipeline drifted.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/publish.yml");
const PUBLISH_COMMAND_PATH = resolve(REPO_ROOT, ".claude/commands/publish.md");
const SCRIPT_PATH = resolve(REPO_ROOT, ".github/scripts/verify-lockstep-versions.mjs");

const workflow = readFileSync(WORKFLOW_PATH, "utf8");

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
}

const manifests = new Map<string, Manifest>();

function readManifest(dir: string): Manifest {
  let manifest = manifests.get(dir);
  if (!manifest) {
    manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, dir, "package.json"), "utf8")) as Manifest;
    manifests.set(dir, manifest);
  }
  return manifest;
}

/**
 * The entries of the `PACKAGE_DIRS: >-` folded block — the workflow's single
 * source of truth for which packages get released.
 */
function readPackageDirs(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === "PACKAGE_DIRS: >-");
  if (start === -1) {
    throw new Error("publish.yml no longer declares PACKAGE_DIRS as a folded block");
  }

  const header = lines[start]!;
  const keyIndent = header.length - header.trimStart().length;
  const dirs: string[] = [];

  for (const line of lines.slice(start + 1)) {
    const indent = line.length - line.trimStart().length;
    // The block ends at the first blank or dedented line.
    if (line.trim() === "" || indent <= keyIndent) {
      break;
    }
    dirs.push(line.trim());
  }

  return dirs;
}

/** Step names in the order the job runs them. */
function readStepNames(source: string): string[] {
  return [...source.matchAll(/^\s*- name: (.+)$/gm)].map((match) => match[1]!.trim());
}

/**
 * One step's whole YAML block, so assertions can cover the keys attached to a
 * step (`if:`, `continue-on-error:`) and not just the command it runs.
 */
function readStepBlock(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) {
    throw new Error(`publish.yml has no step named "${name}"`);
  }

  const header = lines[start]!;
  const stepIndent = header.length - header.trimStart().length;
  const block = [header];

  for (const line of lines.slice(start + 1)) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= stepIndent) {
      break;
    }
    block.push(line);
  }

  return block.join("\n");
}

/**
 * A step's `run:` value, normalised across YAML styles: an inline scalar and a
 * `run: |` block holding the same single command both come back as that one
 * command. That is what lets the gate's command be asserted by equality — the
 * only assertion that survives ` || true`, `; exit 0` and `set +e`, none of
 * which a substring check on the command notices.
 */
function readStepRun(source: string, name: string): string {
  const block = readStepBlock(source, name);
  const lines = block.split("\n");
  const start = lines.findIndex((line) => /^\s*run:/.test(line));
  if (start === -1) {
    throw new Error(`publish.yml step "${name}" has no run: key`);
  }

  const header = lines[start]!;
  const value = /^\s*run:[ \t]*(.*)$/.exec(header)![1]!.trim();
  // Anything that is not a block indicator (`|`, `|-`, `>`, `>-`, `|2` …) is
  // the command itself, written inline.
  if (value !== "" && !/^[|>][-+]?\d*$/.test(value)) {
    return value;
  }

  const runIndent = header.length - header.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= runIndent) {
      break;
    }
    body.push(line.trim());
  }

  return body.join("\n").trim();
}

/**
 * A job's whole YAML block, so the keys that govern every step in it —
 * `if:`, `continue-on-error:` — can be asserted, not just the keys on one
 * step. A job-level `if: false` silences every step underneath it.
 */
function readJobBlock(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `  ${name}:`);
  if (start === -1) {
    throw new Error(`publish.yml has no job named "${name}"`);
  }

  const jobIndent = lines[start]!.length - lines[start]!.trimStart().length;
  const block = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== "" && indent <= jobIndent) {
      break;
    }
    block.push(line);
  }

  return block.join("\n");
}

/** The keys attached directly to a job, ignoring everything nested under them. */
function readJobKeys(source: string, name: string): string[] {
  const lines = readJobBlock(source, name).split("\n").slice(1);
  const keyIndent = Math.min(
    ...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length),
  );

  return lines
    .filter((line) => line.length - line.trimStart().length === keyIndent)
    .map((line) => /^\s*([\w-]+):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

/**
 * The directories `pnpm-workspace.yaml` globs over, reduced to the roots a
 * filesystem walk has to start from. Deriving them from the workspace file
 * rather than hardcoding `packages` is what keeps the coverage assertion
 * below honest when a package lands somewhere new.
 */
function readWorkspaceRoots(): string[] {
  const source = readFileSync(resolve(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "packages:");
  if (start === -1) {
    throw new Error("pnpm-workspace.yaml no longer declares a `packages:` list");
  }

  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      continue;
    }
    // Only the `packages:` list counts. Sweeping the whole file would also
    // pick up the entries of pnpm's other top-level lists — most likely
    // `onlyBuiltDependencies:`, which `pnpm approve-builds` writes — and
    // then try to walk `esbuild/` as if it were a workspace root.
    const entry = /^\s+-\s+["']?([^"'\s]+)/.exec(line);
    if (!entry) {
      break;
    }
    patterns.push(entry[1]!);
  }

  if (patterns.length === 0) {
    throw new Error("pnpm-workspace.yaml declares an empty `packages:` list");
  }

  return [...new Set(patterns.map((pattern) => pattern.split("/")[0]!))];
}

/** Every workspace package directory under `dir`, at any nesting depth. */
function findWorkspacePackages(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const child = `${dir}/${entry.name}`;
    if (existsSync(resolve(REPO_ROOT, child, "package.json"))) {
      found.push(child);
    } else {
      found.push(...findWorkspacePackages(child));
    }
  }
  return found;
}

const packageDirs = readPackageDirs(workflow);

/**
 * The release v0.6.0 shipped `@kavo/prisma` at 0.5.0 and everything else at
 * 0.6.0; repairing that on the registry is a separate issue, so the tree is
 * allowed to still show it. The allowance is deliberately narrow on both
 * axes — an exact directory *and* an exact stale version — and it expires
 * with the release that caused it: it applies only while `@kavo/core` is
 * still on `DRIFTED_RELEASE`.
 *
 * That expiry is the whole point. A blanket "prisma may lag" exception would
 * wave through the next release repeating the exact mistake this file exists
 * to catch (six packages bumped, prisma left behind — still one drifted
 * directory, still matching), while *failing* a correct release that bumped
 * all seven. Keying it to the release inverts both: once `/publish` moves the
 * tree to the next version the allowance is gone, so prisma must come along.
 */
const DRIFTED_RELEASE = "0.6.0";
const KNOWN_DRIFT: Record<string, string> = { "packages/orms/prisma": "0.5.0" };

/** The directories not on `version`, minus the grandfathered v0.6.0 drift. */
function findBehind(version: string | undefined, actual: Record<string, string | undefined>): string[] {
  const tolerated: Record<string, string> = version === DRIFTED_RELEASE ? KNOWN_DRIFT : {};

  return Object.keys(actual).filter((dir) => {
    const found = actual[dir];
    if (found === version) {
      return false;
    }
    // A manifest with no `version` at all is drift, never a match against the
    // allowance: `tolerated[dir]` is also undefined for every directory that
    // is not grandfathered, so comparing the two directly would read a
    // missing field as "in lockstep" — the one thing the gate script itself
    // is careful to call a mismatch.
    if (found === undefined) {
      return true;
    }
    return tolerated[dir] !== found;
  });
}

describe("lockstep versions in this repository", () => {
  /**
   * ADR-0004 is a property of the tree, not only of a release: checking it
   * here means drift fails `pnpm check` on the pull request that introduces
   * it, rather than at a tag push that cannot be cleanly undone.
   */
  it("keeps every package on one version, bar the drift v0.6.0 left behind", () => {
    const version = readManifest("packages/core").version;
    const actual = Object.fromEntries(packageDirs.map((dir) => [dir, readManifest(dir).version]));

    expect(findBehind(version, actual)).toEqual([]);
  });

  it("still fails a release that leaves prisma behind, once the tree moves past v0.6.0", () => {
    const actual = { "packages/core": "0.7.0", "packages/orms/prisma": "0.5.0" };

    expect(findBehind("0.7.0", actual)).toEqual(["packages/orms/prisma"]);
  });

  it("passes a correct release that bumps prisma along with everything else", () => {
    const actual = { "packages/core": "0.7.0", "packages/orms/prisma": "0.7.0" };

    expect(findBehind("0.7.0", actual)).toEqual([]);
  });

  it("fails a package whose version field is missing entirely", () => {
    const actual = { "packages/core": "0.6.0", "packages/protocols/mcp": undefined };

    expect(findBehind("0.6.0", actual)).toEqual(["packages/protocols/mcp"]);
  });

  it("fails prisma at a stale version other than the one grandfathered", () => {
    const actual = { "packages/core": "0.6.0", "packages/orms/prisma": "0.4.0" };

    expect(findBehind("0.6.0", actual)).toEqual(["packages/orms/prisma"]);
  });

  it("fails prisma ahead of the tree as readily as behind it", () => {
    const actual = { "packages/core": "0.6.0", "packages/orms/prisma": "0.7.0" };

    expect(findBehind("0.6.0", actual)).toEqual(["packages/orms/prisma"]);
  });

  it("fails new drift even at the grandfathered version", () => {
    const actual = { "packages/core": "0.6.0", "packages/orms/prisma": "0.5.0", "packages/protocols/mcp": "0.5.0" };

    expect(findBehind("0.6.0", actual)).toEqual(["packages/protocols/mcp"]);
  });
});

/**
 * The root `package.json` is never published, so its `engines.node` is the
 * one place the supported Node floor is decided; every published package
 * must carry a matching literal `engines.node`, or `npm view @kavo/core
 * engines` (and every sibling) stays empty and an install on an unsupported
 * Node version succeeds silently. Modelled on the lockstep-version check
 * above (ADR-0004): the floor is still hand-copied into each manifest, but
 * drift away from the root's value fails here instead of shipping.
 */
describe("engines field lockstep", () => {
  it("declares a non-empty engines.node on the root manifest", () => {
    const root = readManifest(".");

    expect(root.engines?.node).toBeTruthy();
  });

  it("matches every published package's engines.node to the root's", () => {
    const expectedNode = readManifest(".").engines?.node;
    const actual = Object.fromEntries(packageDirs.map((dir) => [dir, readManifest(dir).engines?.node]));

    for (const [dir, node] of Object.entries(actual)) {
      expect(node, `${dir} engines.node`).toBe(expectedNode);
    }
  });
});

/**
 * A protocol binding's peer is **optional to install, required to use**, and
 * only `peerDependenciesMeta` says so to a package manager. Without it,
 * `@kavo/nest` — which depends on both bindings — drags `graphql`, the MCP
 * SDK and its `zod` subtree into every REST-only install (#148).
 *
 * `@kavo/nest` already marks its own three. These two are the transitive
 * hop that made the marking on `@kavo/nest` insufficient, and the pairing is
 * exactly the kind of thing that regresses silently when a package is added:
 * the manifest still installs, the tree is just bigger.
 *
 * Deliberately **not** generalized to "every peer of every package". An ORM
 * adapter's peer is genuinely required — `@kavo/typeorm` without `typeorm`
 * does nothing — so marking those optional would trade a real install-time
 * error for a runtime one.
 */
describe("optional protocol peers", () => {
  const optionalPeers: readonly [dir: string, peer: string][] = [
    ["packages/protocols/graphql", "graphql"],
    ["packages/protocols/mcp", "@modelcontextprotocol/sdk"],
  ];

  it.each(optionalPeers)("marks %s's %s peer optional", (dir, peer) => {
    const manifest = readManifest(dir);

    expect(manifest.peerDependencies?.[peer], `${dir} must still declare ${peer} as a peer`).toBeTruthy();
    expect(manifest.peerDependenciesMeta?.[peer]?.optional, `${dir} peerDependenciesMeta.${peer}.optional`).toBe(true);
  });

  it("keeps @kavo/nest's own marking, since both hops have to say optional", () => {
    // Marking only the leaf does not help: npm resolves `@kavo/nest`'s
    // dependency on the binding, then the binding's peer. Either hop
    // declaring the peer required pulls it in.
    const nest = readManifest("packages/frameworks/nest").peerDependenciesMeta;

    expect(nest?.["graphql"]?.optional).toBe(true);
    expect(nest?.["@modelcontextprotocol/sdk"]?.optional).toBe(true);
  });
});

describe("publish.yml wiring", () => {
  it("triggers on a published GitHub Release (release-please creates it with GITHUB_TOKEN)", () => {
    // A tag pushed by GITHUB_TOKEN does not fire `on: push: tags`; the
    // Release event does. See docs/internals/adr/0041-*.
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[\s*published\s*\]/);
  });

  it("still triggers on a manually pushed vX.Y.Z tag as an escape hatch", () => {
    expect(workflow).toMatch(/push:\s*\n\s*tags:\s*\n\s*-\s*"v\*\.\*\.\*"/);
  });

  it("declares a non-empty PACKAGE_DIRS list of directories that exist", () => {
    expect(packageDirs.length).toBeGreaterThan(0);
    for (const dir of packageDirs) {
      expect(() => readManifest(dir)).not.toThrow();
    }
  });

  it("verifies lockstep versions before anything is packed or published", () => {
    const steps = readStepNames(workflow);
    const verify = steps.indexOf("Verify lockstep versions");
    const pack = steps.indexOf("Pack packages");
    const publish = steps.indexOf("Publish packages");

    expect(verify).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(verify).toBeLessThan(pack);
    expect(verify).toBeLessThan(publish);
  });

  it("runs the gate script over the whole PACKAGE_DIRS list, not one package", () => {
    // By equality, not by substring. Every way of neutering the gate leaves
    // the command itself intact and appends to it — ` || true`, `; exit 0` —
    // so a `toContain` on the command is exactly the assertion that misses
    // them. `$PACKAGE_DIRS` is unquoted on purpose: word splitting is what
    // turns the folded list into one argument per directory.
    expect(readStepRun(workflow, "Verify lockstep versions")).toBe(
      'node .github/scripts/verify-lockstep-versions.mjs "${GITHUB_REF_NAME#v}" $PACKAGE_DIRS',
    );
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("keeps the gate, and everything it guards, unconditional", () => {
    // Three ways to reopen the v0.6.0 hole, all of which used to leave every
    // assertion in this file green: silence the gate step, silence the whole
    // job, or let the steps the gate protects run anyway.
    for (const name of ["Verify lockstep versions", "Pack packages", "Publish packages"]) {
      const step = readStepBlock(workflow, name);
      expect(step, `${name} is conditional`).not.toContain("continue-on-error");
      expect(step, `${name} is conditional`).not.toMatch(/^\s+if:/m);
    }

    expect(readJobKeys(workflow, "publish")).not.toContain("if");
    expect(readJobKeys(workflow, "publish")).not.toContain("continue-on-error");
  });

  it("keeps the skip-if-already-published guard so a re-run after a partial failure completes", () => {
    // The echo alone is not the guard — assert the condition that produces it,
    // or deleting the `if` and leaving an unconditional echo would pass.
    const step = readStepRun(workflow, "Publish packages");

    expect(step).toMatch(/if npm view "\$NAME@\$VERSION" version .*; then/);
    expect(step).toContain("already published, skipping");
    expect(step).toContain("npm publish");
  });

  it("lists every package after the packages it depends on", () => {
    const positionOf = new Map(packageDirs.map((dir, index) => [readManifest(dir).name, index]));

    for (const [index, dir] of packageDirs.entries()) {
      const manifest = readManifest(dir);
      // Peer and optional edges count: `@kavo/graphql` is a lazily-imported
      // optional peer in all but name, and moving it out of `dependencies`
      // must not silently drop it from the ordering rule.
      const edges = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]);

      for (const dependency of [...edges].filter((name) => name.startsWith("@kavo/"))) {
        const dependencyIndex = positionOf.get(dependency);
        expect(dependencyIndex, `${dependency} is missing from PACKAGE_DIRS`).toBeDefined();
        expect(dependencyIndex, `${dir} is published before its dependency ${dependency}`).toBeLessThan(index);
      }
    }
  });

  it("covers exactly the publishable workspace packages", () => {
    const publishable = readWorkspaceRoots()
      .flatMap((root) => findWorkspacePackages(root))
      .filter((dir) => readManifest(dir).private !== true);

    expect([...packageDirs].sort()).toEqual(publishable.sort());
  });

  it("verifies the packed tarballs after packing them and before publishing", () => {
    const steps = readStepNames(workflow);
    const pack = steps.indexOf("Pack packages");
    const verify = steps.indexOf("Verify packed tarballs are installable");
    const publish = steps.indexOf("Publish packages");

    expect(verify).toBeGreaterThanOrEqual(0);
    expect(pack).toBeLessThan(verify);
    expect(verify).toBeLessThan(publish);
  });

  it("inspects every dependency field a consumer installs for workspace: ranges", () => {
    // `pnpm pack` rewriting workspace:^ is the only thing standing between
    // the repo and an uninstallable release, and it is unguarded everywhere
    // else — @kavo/prisma@0.5.0 and @kavo/mongoose@0.6.0 are what that looks
    // like on the registry. devDependencies are excluded on purpose: npm does
    // not install them for consumers.
    const step = readStepRun(workflow, "Verify packed tarballs are installable");

    expect(step).toContain('["dependencies", "optionalDependencies", "peerDependencies"]');
    expect(step).toContain('String(range).includes("workspace:")');
    // The manifest inside the tarball, not the one in the repo — the repo's
    // copy says workspace:^ and always will.
    expect(step).toContain("tar -xzOf");
    expect(step).toContain("package/package.json");
  });

  it("requires each tarball to contain the entry point its own manifest declares", () => {
    // No package declares prepack, so `pnpm pack` builds nothing: packing a
    // tree with no dist/ exits 0 and produces a manifest-only tarball. Only
    // the Check-before-Pack ordering prevents that today, and ordering is a
    // convention rather than a check.
    const step = readStepRun(workflow, "Verify packed tarballs are installable");

    expect(step).toContain('pkg.exports?.["."]?.default ?? pkg.main');
    expect(step).toMatch(/tar -tzf "\$tarball" \| grep -qx "\$ENTRY"/);
    expect(step).toContain("packed without a build");
  });

  it("keeps the tarball verification unconditional and failing", () => {
    // Same three escapes the lockstep gate is held to: a silenced step, an
    // `if:`, or a body that reports without exiting non-zero.
    const block = readStepBlock(workflow, "Verify packed tarballs are installable");

    expect(block).not.toContain("continue-on-error");
    expect(block).not.toMatch(/^\s+if:/m);
    expect(readStepRun(workflow, "Verify packed tarballs are installable")).toContain("exit $status");
  });

  it("publishes an exactly-named tarball rather than a glob", () => {
    // `<prefix>-*.tgz` also matches a sibling whose name extends this one, and
    // `npm publish` takes exactly one spec — so the glob turns a future
    // @kavo/core-utils into an EUSAGE abort partway through a release.
    const step = readStepRun(workflow, "Publish packages");

    expect(step).toContain('-$VERSION.tgz"');
    expect(step).not.toContain('"-*.tgz');
  });

  it("keeps /publish scoped to bootstrapping a brand-new package, not routine releases", () => {
    // Routine releases are a merged release-please PR (ADR-0041). /publish is
    // now only the first-publish bootstrap, and must not have regrown the
    // version-bump / commit-to-main / tag-push machinery release-please owns.
    const doc = readFileSync(PUBLISH_COMMAND_PATH, "utf8");

    expect(doc).toMatch(/bootstrap/i);
    expect(doc).not.toContain("git tag -a");
    expect(doc).not.toContain("chore(release):");
  });
});

describe("verify-lockstep-versions", () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "kavo-lockstep-"));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  /** Writes a throwaway workspace and returns the directories, in order. */
  function writeFixture(name: string, packages: Record<string, unknown>): { cwd: string; dirs: string[] } {
    const cwd = join(fixtureRoot, name);
    for (const [dir, manifest] of Object.entries(packages)) {
      mkdirSync(join(cwd, dir), { recursive: true });
      writeFileSync(join(cwd, dir, "package.json"), JSON.stringify(manifest));
    }
    return { cwd, dirs: Object.keys(packages) };
  }

  function runCheck(cwd: string, args: string[]) {
    return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd, encoding: "utf8" });
  }

  it("passes when every package carries the tag's version", () => {
    const { cwd, dirs } = writeFixture("all-aligned", {
      "packages/core": { name: "@kavo/core", version: "0.6.0" },
      "packages/orms/prisma": { name: "@kavo/prisma", version: "0.6.0" },
      "packages/frameworks/nest": { name: "@kavo/nest", version: "0.6.0" },
    });

    const result = runCheck(cwd, ["0.6.0", ...dirs]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("all 3 packages are at 0.6.0");
  });

  // The v0.6.0 release itself: six packages bumped, @kavo/prisma left behind.
  // The old core-only check passed this; the gate must not.
  it("fails the release when a single package was left behind", () => {
    const { cwd, dirs } = writeFixture("one-left-behind", {
      "packages/core": { name: "@kavo/core", version: "0.6.0" },
      "packages/orms/typeorm": { name: "@kavo/typeorm", version: "0.6.0" },
      "packages/orms/prisma": { name: "@kavo/prisma", version: "0.5.0" },
      "packages/orms/mongoose": { name: "@kavo/mongoose", version: "0.6.0" },
      "packages/protocols/graphql": { name: "@kavo/graphql", version: "0.6.0" },
      "packages/protocols/mcp": { name: "@kavo/mcp", version: "0.6.0" },
      "packages/frameworks/nest": { name: "@kavo/nest", version: "0.6.0" },
    });

    const result = runCheck(cwd, ["0.6.0", ...dirs]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@kavo/prisma (packages/orms/prisma/package.json) is 0.5.0, expected 0.6.0");
    expect(result.stderr).toContain("1 of 7 packages are not at 0.6.0");
    // The packages that were bumped are not named as problems.
    expect(result.stderr).not.toContain("@kavo/core");
  });

  it("names every mismatching package, not just the first", () => {
    const { cwd, dirs } = writeFixture("several-left-behind", {
      "packages/core": { name: "@kavo/core", version: "1.0.0" },
      "packages/orms/prisma": { name: "@kavo/prisma", version: "0.5.0" },
      "packages/protocols/mcp": { name: "@kavo/mcp", version: "0.6.0" },
    });

    const result = runCheck(cwd, ["1.0.0", ...dirs]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@kavo/prisma (packages/orms/prisma/package.json) is 0.5.0, expected 1.0.0");
    expect(result.stderr).toContain("@kavo/mcp (packages/protocols/mcp/package.json) is 0.6.0, expected 1.0.0");
    expect(result.stderr).toContain("2 of 3 packages are not at 1.0.0");
  });

  it("fails when the tag itself is ahead of every package", () => {
    const { cwd, dirs } = writeFixture("tag-ahead", {
      "packages/core": { name: "@kavo/core", version: "0.6.0" },
    });

    const result = runCheck(cwd, ["0.7.0", ...dirs]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@kavo/core (packages/core/package.json) is 0.6.0, expected 0.7.0");
  });

  it("treats a manifest with no version field as a mismatch rather than a pass", () => {
    const { cwd, dirs } = writeFixture("no-version-field", {
      "packages/core": { name: "@kavo/core" },
    });

    const result = runCheck(cwd, ["0.6.0", ...dirs]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("<no version field>");
  });

  it("exits 2 when a listed directory has no manifest, instead of reading as all clear", () => {
    const { cwd } = writeFixture("missing-manifest", {
      "packages/core": { name: "@kavo/core", version: "0.6.0" },
    });

    const result = runCheck(cwd, ["0.6.0", "packages/core", "packages/gone"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cannot read");
    expect(result.stderr).toContain("packages/gone");
  });

  // One run has to report everything it knows: an operator who fixes only the
  // unreadable directory would otherwise spend a second tag discovering the
  // stale version the script had already seen.
  it("reports stale versions alongside unreadable manifests in one run", () => {
    const { cwd } = writeFixture("both-problems", {
      "packages/core": { name: "@kavo/core", version: "0.6.0" },
      "packages/orms/prisma": { name: "@kavo/prisma", version: "0.5.0" },
    });

    const result = runCheck(cwd, ["0.6.0", "packages/core", "packages/orms/prisma", "packages/typo"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("@kavo/prisma (packages/orms/prisma/package.json) is 0.5.0, expected 0.6.0");
    expect(result.stderr).toContain("packages/typo/package.json");
  });

  // `JSON.parse` succeeds on these, so they never reach the catch — they used
  // to crash on the dereference instead, aborting the loop with a stack trace
  // and hiding every package after them.
  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a bare number", "42"],
  ])("treats %s as an unreadable manifest rather than crashing", (label, contents) => {
    const cwd = join(fixtureRoot, `not-an-object-${label.replace(/\W/g, "")}`);
    mkdirSync(join(cwd, "packages/core"), { recursive: true });
    writeFileSync(join(cwd, "packages/core/package.json"), contents);
    mkdirSync(join(cwd, "packages/orms/prisma"), { recursive: true });
    writeFileSync(
      join(cwd, "packages/orms/prisma/package.json"),
      JSON.stringify({ name: "@kavo/prisma", version: "0.5.0" }),
    );

    const result = runCheck(cwd, ["0.6.0", "packages/core", "packages/orms/prisma"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("packages/core/package.json");
    // The loop kept going: the package after the bad manifest is still named.
    expect(result.stderr).toContain("@kavo/prisma (packages/orms/prisma/package.json) is 0.5.0, expected 0.6.0");
  });

  it("exits 2 without an expected version or any package directories", () => {
    const { cwd } = writeFixture("no-args", {
      "packages/core": { name: "@kavo/core", version: "0.6.0" },
    });

    expect(runCheck(cwd, ["0.6.0"]).status).toBe(2);
    expect(runCheck(cwd, []).status).toBe(2);
    expect(runCheck(cwd, []).stderr).toContain("usage:");
  });
});

/**
 * release-please cuts routine releases (ADR-0041): a single release PR on
 * `main` carries the computed lockstep bump and the generated changelog, and
 * merging it creates the `vX.Y.Z` tag + GitHub Release that `publish.yml`
 * runs on. These assertions pin the config that keeps that automated bump in
 * lockstep with `PACKAGE_DIRS` and shaped the way `publish.yml` expects.
 */
describe("release-please config", () => {
  const config = JSON.parse(readFileSync(resolve(REPO_ROOT, "release-please-config.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, ".release-please-manifest.json"), "utf8"));

  it("produces a bare vX.Y.Z tag, matching publish.yml's trigger", () => {
    expect(config["include-component-in-tag"]).toBe(false);
  });

  it("keeps a pre-1.0 breaking change at a minor bump, not 1.0.0", () => {
    expect(config["bump-minor-pre-major"]).toBe(true);
  });

  it("bumps every published package.json in lockstep via extra-files", () => {
    const rootPkg = config.packages["."];
    expect(rootPkg).toBeDefined();
    const jsonExtras = (rootPkg["extra-files"] ?? []).filter((f: { type: string }) => f.type === "json");
    const extraDirs = jsonExtras.map((f: { path: string }) => f.path.replace(/\/package\.json$/, ""));
    // PACKAGE_DIRS stays the only authority for the released set; extra-files
    // must cover exactly it. (The "." entry additionally bumps the private
    // root manifest, which is not in PACKAGE_DIRS.)
    expect([...extraDirs].sort()).toEqual([...packageDirs].sort());
    for (const f of jsonExtras) {
      expect(f.jsonpath, `${f.path} jsonpath`).toBe("$.version");
    }
  });

  it("seeds the manifest at the current released version and never lets it drift", () => {
    expect(manifest["."]).toBe(readManifest("packages/core").version);
  });

  it("only names changelog sections for types the repo actually uses", () => {
    const KNOWN = new Set(["feat", "fix", "chore", "test", "docs", "refactor", "perf", "ci"]);
    for (const section of config["changelog-sections"] ?? []) {
      expect(KNOWN.has(section.type), `unknown changelog type: ${section.type}`).toBe(true);
    }
  });

  it("titles the release PR with the version so the squash commit carries it", () => {
    // The pattern is bidirectional: release-please writes the PR title with it
    // AND parses the merged title back through it to recover ${version} when
    // cutting the release, so ${component} has to stay in the pattern even
    // though it renders empty here. Dropping it fails release cutting with
    // "Expected 1 releases, only found 0" (see ADR-0041).
    expect(config["pull-request-title-pattern"]).toBe("chore: release${component} v${version}");
    // separate-pull-requests:false makes this a grouped PR, whose title comes
    // from group-pull-request-title-pattern (default: "chore: release ${branch}").
    expect(config["group-pull-request-title-pattern"]).toBe("chore: release${component} v${version}");
    // package-name MUST be "" (empty string), not absent: it short-circuits the
    // branch-component lookup before release-please reads the root package.json
    // name, so createReleases' component check is "" === "" instead of
    // "" !== "kavo" and the tag actually gets cut (see ADR-0041).
    expect(config.packages["."]["package-name"]).toBe("");
  });
});

describe("release-please workflow", () => {
  const wf = readFileSync(resolve(REPO_ROOT, ".github/workflows/release-please.yml"), "utf8");

  it("runs on pushes to main", () => {
    expect(wf).toMatch(/push:[\s\S]*branches:\s*\[?\s*main/);
  });

  it("grants the permissions release-please needs to open its PR and tag", () => {
    expect(wf).toMatch(/contents:\s*write/);
    expect(wf).toMatch(/pull-requests:\s*write/);
  });

  it("points release-please at the repo's config and manifest files", () => {
    expect(wf).toContain("release-please-config.json");
    expect(wf).toContain(".release-please-manifest.json");
    expect(wf).toContain("googleapis/release-please-action@v4");
  });

  it("also cuts the release when the release PR is merged (push is suppressed for GITHUB_TOKEN commits)", () => {
    // Merging release-please's own PR does not fire `on: push` — its commits
    // are authored by github-actions[bot] via the default GITHUB_TOKEN. The
    // `pull_request: closed` event fires on the human merge instead.
    expect(wf).toMatch(/pull_request:\s*\n\s*types:\s*\[?\s*closed/);
    expect(wf).toContain("github.event.pull_request.merged == true");
    expect(wf).toContain("release-please--branches--main");
  });

  it("has a manual escape hatch to reconcile a release that never got cut", () => {
    expect(wf).toContain("workflow_dispatch:");
  });
});
