import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildDocs7, convertPage, diffTrees } from "../scripts/build-docs7.mjs";

/**
 * `docs7/` — the Docs7 build of the docs — as a set of assertions.
 *
 * Docs7 builds the committed `docs7/` folder and never runs
 * `scripts/build-docs7.mjs`, so a docs edit that forgets `pnpm docs7:build`
 * ships a stale site silently. The first block is the guard against that; the
 * rest pins the translations the generator exists for, so a regression shows
 * up here rather than as a failed Docs7 build.
 */

const DOCS7 = fileURLToPath(new URL("../docs7", import.meta.url));

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kavo-docs7-spec-"));
  scratch.push(dir);
  return dir;
}

describe("docs7/ is in sync with docs/", () => {
  it("matches what the generator produces from the current docs/", () => {
    const fresh = tempDir();
    buildDocs7(fresh);
    expect(diffTrees(fresh, DOCS7), "docs7/ is stale — run `pnpm docs7:build`").toEqual([]);
  });

  it("reports a changed, a missing, and an extra file rather than passing", () => {
    const expected = tempDir();
    const actual = tempDir();
    writeFileSync(join(expected, "a.mdx"), "new\n");
    writeFileSync(join(expected, "b.mdx"), "b\n");
    writeFileSync(join(actual, "a.mdx"), "old\n");
    mkdirSync(join(actual, "gone"));
    writeFileSync(join(actual, "gone", "c.mdx"), "c\n");

    expect(diffTrees(expected, actual).sort()).toEqual([
      "extra:   docs7/gone/c.mdx",
      "missing: docs7/b.mdx",
      "stale:   docs7/a.mdx",
    ]);
  });
});

describe("convertPage", () => {
  it("lifts the leading H1 into title frontmatter", () => {
    const mdx = convertPage("# The `@Kavo` decorator\n\nBody.\n", "reference/decorators.md");
    expect(mdx).toMatch(/^---\ntitle: "The @Kavo decorator"\n---\n/);
    expect(mdx).not.toContain("# The");
    expect(mdx).toContain("\nBody.\n");
  });

  it("fails on a page with no title rather than emitting one Docs7 rejects", () => {
    expect(() => convertPage("Body only.\n", "x.md")).toThrow(/no "# Title"/);
  });

  it("turns a code-group into <CodeGroup> with Docs7 fence labels", () => {
    const mdx = convertPage("# T\n\n::: code-group\n\n```bash [pnpm]\npnpm add x\n```\n\n:::\n", "x.md");
    expect(mdx).toContain("<CodeGroup>\n\n```bash pnpm\npnpm add x\n```\n\n</CodeGroup>");
  });

  it("turns a titled danger container into <Danger> with a bold lead", () => {
    const mdx = convertPage("# T\n\n::: danger Careful `now`\nText.\n:::\n", "x.md");
    expect(mdx).toContain("<Danger>\n**Careful `now`**\n\nText.\n</Danger>");
  });

  it("fails on a VitePress container it has no Docs7 equivalent for", () => {
    expect(() => convertPage("# T\n\n::: v-pre\nx\n:::\n", "x.md")).toThrow(/unsupported VitePress container/);
  });

  it("drops <script setup> and the page-bound StackPicker, and renders the free one as cards", () => {
    const bound = convertPage(
      '# T\n\n<script setup lang="ts">\nimport S from "./S.vue";\n</script>\n\n<StackPicker orm="prisma" />\n\nAfter.\n',
      "x.md",
    );
    expect(bound).not.toMatch(/<script|StackPicker|import S/);
    expect(bound).toContain("After.");

    const free = convertPage("# T\n\n<StackPicker />\n", "x.md");
    expect(free).toContain('<Card title="Nest + Prisma" href="/integrations/orms/prisma" />');
  });

  it("fails on any other Vue component instead of dropping content silently", () => {
    expect(() => convertPage("# T\n\n<FeatureGrid />\n", "x.md")).toThrow(/<FeatureGrid>/);
  });

  it("escapes MDX-significant prose but leaves code spans and fences literal", () => {
    const mdx = convertPage(
      "# T\n\nSet { a } with `{ a: 1 }` and ``a ` {b}``, not <Entity>.\n\n```ts\nconst x = { a: <T>1 };\n```\n",
      "x.md",
    );
    expect(mdx).toContain("Set \\{ a \\} with `{ a: 1 }` and ``a ` {b}``, not &lt;Entity>.");
    expect(mdx).toContain("```ts\nconst x = { a: <T>1 };\n```");
  });

  it("drops HTML comments and turns autolinks into markdown links", () => {
    const mdx = convertPage("# T\n\n<!-- note -->\nSee <https://kavo.js.org>.\n", "x.md");
    expect(mdx).not.toContain("note");
    expect(mdx).toContain("See [https://kavo.js.org](https://kavo.js.org).");
  });

  it("rewrites .md, relative, and out-of-docs links to Docs7 routes or GitHub", () => {
    const mdx = convertPage(
      "# T\n\n[a](../adr/0002-package-topology.md#context) [b](/guides/configuration/) [c](../../../packages/core/src/index.ts) [d](https://x.dev/a.md)\n",
      "internals/architecture/01-system-architecture.md",
    );
    expect(mdx).toContain("[a](/internals/adr/0002-package-topology#context)");
    expect(mdx).toContain("[b](/guides/configuration)");
    expect(mdx).toContain("[c](https://github.com/kavo-labs/kavo/blob/main/packages/core/src/index.ts)");
    expect(mdx).toContain("[d](https://x.dev/a.md)");
  });
});
