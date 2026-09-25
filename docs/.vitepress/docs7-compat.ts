/**
 * `docs/` is one source for two renderers: VitePress (kavo.js.org) and Docs7,
 * which reads the same folder through `docs/docs.json` and compiles every page
 * as MDX. So pages are written in the syntax MDX accepts, and this rewrites the
 * few constructs VitePress spells differently, before markdown-it parses the
 * page:
 *
 * - `<CodeGroup>` … `</CodeGroup>` becomes `::: code-group` … `:::`, and each
 *   fence's Docs7 tab label (```` ```bash pnpm ````) becomes VitePress's
 *   (```` ```bash [pnpm] ````).
 * - `<Danger>`, `<Warning>`, `<Tip>`, `<Note>` and `<Info>` become the matching
 *   `:::` custom container. A bold line directly under the tag, followed by a
 *   blank line, becomes the container's title.
 * - A `{/* vitepress` … `*\/}` block is an MDX comment, so Docs7 renders
 *   nothing; here its body is kept. That is where `<script setup>` and Vue
 *   components go, which MDX cannot parse.
 * - A `{/* docs7 *\/}` … `{/* /docs7 *\/}` block is the reverse: content Docs7
 *   renders and VitePress drops.
 *
 * Every tag and marker must sit on a line of its own, outside a code fence.
 */

const CONTAINERS = new Map([
  ["Danger", "danger"],
  ["Warning", "warning"],
  ["Tip", "tip"],
  ["Note", "info"],
  ["Info", "info"],
]);

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const LABELLED_INFO = /^(\S+)\s+([^[{].*)$/;
const CONTAINER_TAG = /^<(\/?)([A-Z][a-z]+)>$/;
const BOLD_LINE = /^\*\*(.+)\*\*$/;

export function docs7ToVitePress(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  let inCodeGroup = false;
  let inVitePressBlock = false;
  let inDocs7Block = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const [, marker = "", info = ""] = FENCE.exec(trimmed) ?? [];

    if (fence !== undefined) {
      if (marker.startsWith(fence) && info.trim() === "") {
        fence = undefined;
      }
      if (!inDocs7Block) {
        out.push(line);
      }
      continue;
    }

    if (marker) {
      fence = marker;
      const [, lang, label] = LABELLED_INFO.exec(info.trim()) ?? [];
      if (!inDocs7Block) {
        out.push(inCodeGroup && lang && label ? `${marker}${lang} [${label}]` : line);
      }
      continue;
    }

    if (trimmed === "{/* docs7 */}" || trimmed === "{/* /docs7 */}") {
      inDocs7Block = trimmed === "{/* docs7 */}";
      continue;
    }
    if (inDocs7Block) {
      continue;
    }

    if (trimmed === "{/* vitepress" || (inVitePressBlock && trimmed === "*/}")) {
      inVitePressBlock = !inVitePressBlock;
      continue;
    }

    if (trimmed === "<CodeGroup>" || trimmed === "</CodeGroup>") {
      inCodeGroup = trimmed === "<CodeGroup>";
      out.push(inCodeGroup ? "::: code-group" : ":::");
      continue;
    }

    const [, closing, tag = ""] = CONTAINER_TAG.exec(trimmed) ?? [];
    const container = CONTAINERS.get(tag);
    if (container && closing) {
      out.push(":::");
      continue;
    }
    if (container) {
      const [, title] = BOLD_LINE.exec(lines[i + 1]?.trim() ?? "") ?? [];
      if (title && lines[i + 2]?.trim() === "") {
        out.push(`::: ${container} ${title}`);
        i += 2;
      } else {
        out.push(`::: ${container}`);
      }
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}
