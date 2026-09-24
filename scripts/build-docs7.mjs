#!/usr/bin/env node
//
// Generates `docs7/`, the Docs7 (context7.com/docs/docs7) build of the docs.
//
// `docs/` is VitePress source and stays the only thing anyone edits: its pages
// use VitePress-only syntax (`::: code-group`, `<script setup>` Vue components)
// that MDX cannot parse, and kavo.js.org is built from it. Docs7 builds a
// connected repo's committed files without running any of its scripts, so the
// MDX it needs has to be committed too. This script is the one translation:
//
//   - every rendered page (VitePress `srcExclude` rules) becomes `<page>.mdx`,
//     its leading `# H1` lifted into `title` frontmatter;
//   - `::: code-group` becomes `<CodeGroup>` (fence labels `ts [File]` become
//     `ts File`), and `::: tip|info|warning|danger|details` their Docs7
//     callout/accordion;
//   - `<script setup>` blocks are dropped, and the one Vue component in page
//     bodies, `<StackPicker>`, becomes static cards (or nothing, on the ORM
//     page it is bound to); any other component fails the build;
//   - prose is escaped for MDX (`{`, `}`, `<`), HTML comments are dropped, and
//     autolinks and `.md`/relative links become Docs7 routes — a link that
//     leaves `docs/` points at the file on GitHub instead;
//   - `docs/docs.json` is copied verbatim (it is the navigation's single
//     source), along with the brand assets from `docs/public/`;
//   - the landing page is hand-written (`scripts/docs7/index.mdx`), because
//     VitePress's `layout: home` page is Vue components, not prose.
//
// `node scripts/build-docs7.mjs` rewrites `docs7/`; `--check` regenerates into a
// temp dir and fails if the committed tree differs, which
// `tests/docs7-sync.spec.ts` runs so a docs edit cannot leave the site stale.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "docs");
const OUT = join(ROOT, "docs7");
const OVERRIDES = join(ROOT, "scripts", "docs7");
const GITHUB_BLOB = "https://github.com/kavo-labs/kavo/blob/main/";

/** Mirrors `srcExclude` in docs/.vitepress/config.mts, plus the landing page (hand-written). */
const isExcluded = (rel) =>
  rel === "README.md" ||
  rel === "index.md" ||
  rel.startsWith("superpowers/") ||
  rel.split("/").some((part) => part.startsWith("."));

/** `docs/public/` files Docs7 has a use for; CNAME, robots.txt and llms.txt belong to kavo.js.org. */
const PUBLIC_ASSETS = ["favicon.svg", "apple-touch-icon.png", "og-image.png", "og-image.svg"];

const CALLOUTS = { tip: "Tip", info: "Info", warning: "Warning", danger: "Danger", note: "Note" };

const STACK_PICKER_CARDS = `<Columns cols={2}>
  <Card title="Nest + TypeORM" href="/integrations/orms/typeorm" />
  <Card title="Nest + Prisma" href="/integrations/orms/prisma" />
  <Card title="Nest + Mongoose" href="/integrations/orms/mongoose" />
  <Card title="Nest + MikroORM" href="/integrations/orms/mikroorm" />
  <Card title="Next.js" href="/integrations/frameworks/nextjs" />
</Columns>`;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const toPosix = (path) => path.split(sep).join("/");

/** `guides/configuration/index.md` → `/guides/configuration`; `core/entities.md` → `/core/entities`. */
const routeOf = (relMd) => "/" + relMd.replace(/\.md$/, "").replace(/(^|\/)index$/, "");

function rewriteLink(target, fromRel) {
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) {
    return target; // absolute URL, mailto:, or in-page anchor
  }
  const hashAt = target.indexOf("#");
  const path = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : target.slice(hashAt);
  if (path.startsWith("/")) {
    // VitePress site-absolute: already a route, minus any `.md` or trailing slash.
    return (path.replace(/\.md$/, "").replace(/(.)\/$/, "$1") || "/") + hash;
  }
  const resolved = posix.normalize(posix.join("docs", posix.dirname(fromRel), path));
  if (!resolved.startsWith("docs/")) {
    return GITHUB_BLOB + resolved.replace(/^(\.\.\/)+/, "") + hash;
  }
  const relToDocs = resolved.slice("docs/".length);
  return (relToDocs.endsWith(".md") ? routeOf(relToDocs) : "/" + relToDocs.replace(/\/$/, "")) + hash;
}

/**
 * Escapes one run of prose (never a fenced block) for MDX. Code spans are kept
 * verbatim — MDX leaves their contents literal — and are matched the CommonMark
 * way: a closing backtick run of the same length, not across a blank line.
 */
function escapeProse(text, fromRel) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i))[0];
      const closeRe = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
      closeRe.lastIndex = i + run.length;
      const close = closeRe.exec(text);
      const blank = text.slice(i).search(/\n[ \t]*\n/);
      if (close && (blank === -1 || close.index < i + blank)) {
        out += text.slice(i, close.index + run.length);
        i = close.index + run.length;
        continue;
      }
      out += run;
      i += run.length;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (ch === "<") {
      const autolink = /^<((?:https?|mailto):[^>\s]+)>/.exec(text.slice(i));
      if (autolink) {
        out += `[${autolink[1]}](${autolink[1]})`;
        i += autolink[0].length;
        continue;
      }
      out += "&lt;";
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "}") {
      out += "\\" + ch;
      i += 1;
      continue;
    }
    if (ch === "]" && text[i + 1] === "(") {
      // Inline link destination: rewrite it, leave the title (if any) alone.
      const dest = /^\]\(([^)\s]+)/.exec(text.slice(i));
      if (dest) {
        out += "](" + rewriteLink(dest[1], fromRel);
        i += dest[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  // Reference-style link definitions: `[label]: target`.
  return out.replace(/^(\s*\[[^\]]+\]:\s+)(\S+)/gm, (_, lead, target) => lead + rewriteLink(target, fromRel));
}

export function convertPage(source, rel) {
  let body = source;
  let title;
  let description;
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (frontmatter) {
    body = body.slice(frontmatter[0].length);
    title = /^title:\s*(.+)$/m.exec(frontmatter[1])?.[1].replace(/^["']|["']$/g, "");
    description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1].replace(/^["']|["']$/g, "");
  }

  const lines = body.split("\n");
  const out = [];
  let prose = [];
  const containers = [];
  let fence; // { marker, indent, inCodeGroup }

  const flushProse = () => {
    if (prose.length > 0) {
      out.push(escapeProse(prose.join("\n"), rel));
      prose = [];
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (fence) {
      out.push(line);
      if (new RegExp(`^\\s*${fence.marker[0]}{${fence.marker.length},}\\s*$`).test(line)) {
        fence = undefined;
      }
      continue;
    }

    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      flushProse();
      let info = open[3];
      // VitePress labels a fence `lang [Label]`; Docs7 takes `lang Label`.
      info = info.replace(/^(\S*)\s*\[([^\]]+)\]/, (_, lang, label) => `${lang || "text"} ${label}`);
      out.push(open[1] + open[2] + info);
      fence = { marker: open[2] };
      continue;
    }

    if (/^<script\b/.test(line)) {
      flushProse();
      while (index < lines.length && !/<\/script>/.test(lines[index])) {
        index++;
      }
      continue;
    }

    const component = /^<([A-Z]\w*)\b[^>]*\/>\s*$/.exec(line);
    if (component) {
      flushProse();
      if (component[1] !== "StackPicker") {
        throw new Error(`${rel}:${index + 1}: no Docs7 equivalent for Vue component <${component[1]}>`);
      }
      // Page-bound (`orm="…"`) it only switches between ORM pages; the sidebar does that on Docs7.
      if (!/\borm=/.test(line)) {
        out.push(STACK_PICKER_CARDS);
      }
      continue;
    }

    const container = /^:::\s*([a-z-]+)\s*(.*)$/.exec(line);
    if (container) {
      flushProse();
      const [, kind, label] = container;
      if (kind === "code-group") {
        out.push("<CodeGroup>");
        containers.push("</CodeGroup>");
      } else if (kind === "details") {
        out.push(`<Accordion title=${JSON.stringify(label || "Details")}>`);
        containers.push("</Accordion>");
      } else if (CALLOUTS[kind]) {
        out.push(`<${CALLOUTS[kind]}>`);
        if (label) {
          out.push(escapeProse(`**${label}**`, rel), "");
        }
        containers.push(`</${CALLOUTS[kind]}>`);
      } else {
        throw new Error(`${rel}:${index + 1}: unsupported VitePress container "::: ${kind}"`);
      }
      continue;
    }
    if (/^:::\s*$/.test(line)) {
      flushProse();
      if (containers.length === 0) {
        throw new Error(`${rel}:${index + 1}: unmatched ":::"`);
      }
      out.push(containers.pop());
      continue;
    }

    if (title === undefined && line.startsWith("# ") && out.length === 0 && prose.every((l) => l.trim() === "")) {
      title = line.slice(2).trim().replace(/`/g, "");
      prose = [];
      continue;
    }

    prose.push(line);
  }
  flushProse();
  if (fence) {
    throw new Error(`${rel}: unterminated code fence`);
  }
  if (containers.length > 0) {
    throw new Error(`${rel}: unterminated "::: " container`);
  }
  if (title === undefined) {
    throw new Error(`${rel}: no "# Title" line or title frontmatter`);
  }

  const head = ["---", `title: ${JSON.stringify(title)}`];
  if (description) {
    head.push(`description: ${JSON.stringify(description)}`);
  }
  head.push(
    "---",
    "",
    `{/* Generated from docs/${rel} by scripts/build-docs7.mjs. Edit that file, then run pnpm docs7:build. */}`,
    "",
  );
  return (
    head.join("\n") +
    "\n" +
    out
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n*$/, "\n")
  );
}

export function buildDocs7(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const file of walk(SRC)) {
    const rel = toPosix(relative(SRC, file));
    if (!rel.endsWith(".md") || isExcluded(rel)) {
      continue;
    }
    const target = join(outDir, rel.replace(/\.md$/, ".mdx"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, convertPage(readFileSync(file, "utf-8"), rel));
  }

  cpSync(join(SRC, "docs.json"), join(outDir, "docs.json"));
  for (const asset of PUBLIC_ASSETS) {
    cpSync(join(SRC, "public", asset), join(outDir, asset));
  }
  cpSync(OVERRIDES, outDir, { recursive: true });
}

export function diffTrees(expected, actual) {
  const list = (dir) =>
    new Set(
      (statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? walk(dir) : []).map((f) => toPosix(relative(dir, f))),
    );
  const want = list(expected);
  const have = list(actual);
  const problems = [];
  for (const rel of want) {
    if (!have.has(rel)) {
      problems.push(`missing: docs7/${rel}`);
    } else if (!readFileSync(join(expected, rel)).equals(readFileSync(join(actual, rel)))) {
      problems.push(`stale:   docs7/${rel}`);
    }
  }
  for (const rel of have) {
    if (!want.has(rel)) {
      problems.push(`extra:   docs7/${rel}`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const scratch = mkdtempSync(join(tmpdir(), "kavo-docs7-"));
    try {
      buildDocs7(scratch);
      const problems = diffTrees(scratch, OUT);
      if (problems.length > 0) {
        console.error(`docs7/ is out of date with docs/ — run \`pnpm docs7:build\`:\n  ${problems.join("\n  ")}`);
        process.exit(1);
      }
      console.log("docs7 OK — docs7/ matches what docs/ generates");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    buildDocs7(OUT);
    console.log(`docs7/ regenerated from docs/`);
  }
}
