import { compile } from "@mdx-js/mdx";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { docs7ToVitePress } from "../docs/.vitepress/docs7-compat";

/**
 * `docs/` is served twice: VitePress builds kavo.js.org from it, and Docs7
 * reads the same folder through `docs/docs.json` and compiles every page as
 * MDX. VitePress accepts markdown MDX rejects (`<script setup>`, `:::`
 * containers, a wrapped line opening with `{`), and nothing in the VitePress
 * build notices, so this compiles each page the way Docs7 does. Pages keep
 * VitePress-only syntax behind the markers `docs7-compat.ts` rewrites.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = resolve(REPO_ROOT, "docs");

// The same set VitePress renders: `srcExclude` in docs/.vitepress/config.mts.
const pages = execFileSync("git", ["ls-files", "--", "*.md"], { cwd: DOCS, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((page) => page !== "README.md" && !page.startsWith("superpowers/"));

describe("docs/ compiles as MDX for Docs7", () => {
  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThan(50);
    expect(pages).toContain("index.md");
  });

  it.each(pages)("%s", async (page) => {
    const source = readFileSync(resolve(DOCS, page), "utf8");
    await expect(compile(source, { remarkPlugins: [remarkGfm, remarkFrontmatter] })).resolves.toBeDefined();
  });
});

describe("docs7ToVitePress", () => {
  it("turns a CodeGroup into a code-group container with bracketed tab labels", () => {
    const src = ["<CodeGroup>", "", "```bash pnpm", "pnpm add x", "```", "", "```ts", "x", "```", "", "</CodeGroup>"];
    expect(docs7ToVitePress(src.join("\n")).split("\n")).toEqual([
      "::: code-group",
      "",
      "```bash [pnpm]",
      "pnpm add x",
      "```",
      "",
      "```ts",
      "x",
      "```",
      "",
      ":::",
    ]);
  });

  it("leaves fence labels alone outside a CodeGroup", () => {
    expect(docs7ToVitePress("```ts title\nx\n```")).toBe("```ts title\nx\n```");
  });

  it("turns a callout into a container, promoting a leading bold line to its title", () => {
    expect(docs7ToVitePress("<Danger>\n**Careful `now`**\n\nBody.\n</Danger>")).toBe(
      "::: danger Careful `now`\nBody.\n:::",
    );
    expect(docs7ToVitePress("<Note>\nBody.\n</Note>")).toBe("::: info\nBody.\n:::");
  });

  it("unwraps vitepress blocks and drops docs7 blocks", () => {
    const src = "{/* docs7 */}\n# Only Docs7\n{/* /docs7 */}\n{/* vitepress\n<StackPicker />\n*/}\nShared.";
    expect(docs7ToVitePress(src)).toBe("<StackPicker />\nShared.");
  });

  it("does not rewrite markers inside a code fence", () => {
    const src = "````md\n<CodeGroup>\n{/* vitepress\n*/}\n````";
    expect(docs7ToVitePress(src)).toBe(src);
  });
});
