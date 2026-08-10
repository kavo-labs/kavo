import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type HeadConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const hostname = "https://kavo.js.org";

const corePackageJsonUrl = new URL("../../packages/core/package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(fileURLToPath(corePackageJsonUrl), "utf-8")) as { version: string };

const config = defineConfig({
  title: "Kavo",
  description: "A production-grade CRUD framework for TypeScript",
  base: "/",
  srcDir: ".",
  srcExclude: ["README.md", "superpowers/**"],
  cleanUrls: true,
  ignoreDeadLinks: [/CLAUDE(\.md)?$/],
  appearance: "dark",

  // `theme` here is the light-appearance theme only: vitepress-plugin-mermaid
  // watches the `.dark` class and forces mermaid's own "dark" theme when the
  // appearance toggle is on. `securityLevel` restores mermaid's default, which
  // the plugin otherwise relaxes to "loose".
  mermaid: {
    theme: "default",
    securityLevel: "strict",
  },

  sitemap: {
    hostname,
  },

  head: [
    [
      "meta",
      {
        name: "keywords",
        content: "TypeScript, CRUD, REST API, GraphQL, MCP, NestJS, TypeORM, Prisma, Mongoose, MikroORM, realtime",
      },
    ],
    ["meta", { name: "robots", content: "index, follow" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Kavo" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { property: "og:image", content: `${hostname}/og-image.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: "Kavo — turn models into APIs" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${hostname}/og-image.png` }],
    ["meta", { name: "twitter:image:alt", content: "Kavo — turn models into APIs" }],
    ["meta", { name: "theme-color", content: "#7c5cff" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
  ],

  transformHead({ pageData }) {
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
    const url = `${hostname}/${path}`;
    const isHome = path === "";
    const title = isHome ? "Kavo — Turn models into APIs" : `${pageData.title} | Kavo`;
    const description = pageData.description || "A production-grade CRUD framework for TypeScript";

    const head: HeadConfig[] = [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];

    if (isHome) {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Kavo",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Node.js",
          description: "A production-grade CRUD framework for TypeScript",
          url: hostname,
          image: `${hostname}/og-image.png`,
          offers: {
            "@type": "Offer",
            price: "0",
            priceCurrency: "USD",
          },
        }),
      ]);
    }

    return head;
  },

  themeConfig: {
    logo: "/favicon.svg",

    nav: [
      { text: "Getting started", link: "/getting-started" },
      {
        text: "Integrations",
        items: [
          { text: "Nest + TypeORM", link: "/integrations/nest/typeorm" },
          { text: "Nest + Prisma", link: "/integrations/nest/prisma" },
          { text: "Nest + Mongoose", link: "/integrations/nest/mongoose" },
          { text: "Nest + MikroORM", link: "/integrations/nest/mikroorm" },
          { text: "Nest configuration", link: "/integrations/nest/configuration" },
        ],
      },
      { text: "Using the API", link: "/using-the-api" },
    ],

    version,

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "Using the API", link: "/using-the-api" },
        ],
      },
      {
        text: "Integrations",
        items: [
          {
            text: "Nest",
            items: [
              { text: "TypeORM", link: "/integrations/nest/typeorm" },
              { text: "Prisma", link: "/integrations/nest/prisma" },
              { text: "Mongoose", link: "/integrations/nest/mongoose" },
              { text: "MikroORM", link: "/integrations/nest/mikroorm" },
              { text: "Configuration", link: "/integrations/nest/configuration" },
            ],
          },
        ],
      },
      {
        text: "For contributors",
        collapsed: true,
        items: [
          {
            text: "Blueprint",
            collapsed: true,
            items: [
              { text: "System architecture", link: "/internals/architecture/01-system-architecture" },
              { text: "Monorepo and packages", link: "/internals/architecture/02-monorepo-and-packages" },
              {
                text: "Core contracts and type system",
                link: "/internals/architecture/03-core-contracts-and-type-system",
              },
            ],
          },
          {
            text: "Walking skeleton",
            collapsed: true,
            items: [
              { text: "DTO system", link: "/internals/architecture/04-dto-system" },
              { text: "Query grammar", link: "/internals/architecture/05-query-grammar" },
              { text: "Error handling", link: "/internals/architecture/06-error-handling" },
              { text: "CRUD engine", link: "/internals/architecture/07-crud-engine" },
              { text: "Configuration", link: "/internals/architecture/08-configuration" },
              { text: "TypeORM adapter", link: "/internals/architecture/09-typeorm-adapter" },
              { text: "NestJS integration", link: "/internals/architecture/10-nestjs-integration" },
            ],
          },
          {
            text: "Core features",
            collapsed: true,
            items: [
              { text: "Soft delete", link: "/internals/architecture/11-soft-delete" },
              { text: "Relations and includes", link: "/internals/architecture/12-relations-and-includes" },
              { text: "GraphQL binding", link: "/internals/architecture/13-graphql-binding" },
              { text: "Prisma adapter", link: "/internals/architecture/14-prisma-adapter" },
              { text: "Mongoose adapter", link: "/internals/architecture/15-mongoose-adapter" },
              { text: "MCP binding", link: "/internals/architecture/16-mcp-binding" },
              { text: "MikroORM adapter", link: "/internals/architecture/17-mikroorm-adapter" },
              { text: "Realtime", link: "/internals/architecture/18-realtime" },
            ],
          },
          {
            text: "ADRs",
            collapsed: true,
            items: [
              {
                text: "0001 — Clean architecture, core owns contracts",
                link: "/internals/adr/0001-clean-architecture-core-owns-contracts",
              },
              { text: "0002 — Package topology", link: "/internals/adr/0002-package-topology" },
              {
                text: "0003 — pnpm, plain scripts, tsc build",
                link: "/internals/adr/0003-pnpm-plain-scripts-tsc-build",
              },
              { text: "0004 — Lockstep versioning", link: "/internals/adr/0004-lockstep-versioning" },
              {
                text: "0005 — Core zero runtime dependencies",
                link: "/internals/adr/0005-core-zero-runtime-dependencies",
              },
              { text: "0006 — Registry-driven operations", link: "/internals/adr/0006-registry-driven-operations" },
              {
                text: "0007 — Module-augmentable operation metadata",
                link: "/internals/adr/0007-module-augmentable-operation-metadata",
              },
              { text: "0008 — Field-path recursion cap", link: "/internals/adr/0008-field-path-recursion-cap" },
              { text: "0009 — Problem-details error shape", link: "/internals/adr/0009-problem-details-error-shape" },
              { text: "0010 — Explicit named barrel", link: "/internals/adr/0010-explicit-named-barrel" },
              {
                text: "0011 — Entity-metadata infrastructure seam",
                link: "/internals/adr/0011-entity-metadata-infrastructure-seam",
              },
              {
                text: "0012 — Decoration-time route generation",
                link: "/internals/adr/0012-decoration-time-route-generation",
              },
              {
                text: "0013 — Config-declared soft-delete operations",
                link: "/internals/adr/0013-config-declared-soft-delete-operations",
              },
              {
                text: "0014 — Associate by id, not deep writes",
                link: "/internals/adr/0014-associate-by-id-not-deep-writes",
              },
              {
                text: "0015 — Global operation defaults are engine-only",
                link: "/internals/adr/0015-global-operation-defaults-are-engine-only",
              },
              { text: "0016 — GraphQL protocols package", link: "/internals/adr/0016-graphql-protocols-package" },
              {
                text: "0017 — Prisma marker classes and entity registry",
                link: "/internals/adr/0017-prisma-marker-classes-and-entity-registry",
              },
              {
                text: "0018 — Mongoose models are entity identities",
                link: "/internals/adr/0018-mongoose-models-are-entity-identities",
              },
              {
                text: "0019 — Computed fields are serializer-evaluated",
                link: "/internals/adr/0019-computed-fields-are-serializer-evaluated",
              },
              {
                text: "0020 — Content-hash ETags and the engine read seam",
                link: "/internals/adr/0020-content-hash-etags-and-the-engine-read-seam",
              },
              {
                text: "0021 — Cursor pagination is an opaque keyset union",
                link: "/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union",
              },
              {
                text: "0022 — Since pagination composes a value|id keyset",
                link: "/internals/adr/0022-since-pagination-composes-a-value-id-keyset",
              },
              {
                text: "0023 — Realtime transports are resolved config, not settings",
                link: "/internals/adr/0023-realtime-transports-are-not-settings",
              },
              {
                text: "0024 — Collection channels reuse the filter grammar and vocabulary",
                link: "/internals/adr/0024-collection-channels-reuse-the-filter-grammar-and-vocabulary",
              },
              {
                text: "0025 — Handlers reach persistence through the request context",
                link: "/internals/adr/0025-handlers-reach-persistence-through-the-context",
              },
              {
                text: "0026 — selectable narrows the response projection",
                link: "/internals/adr/0026-selectable-narrows-the-response-projection",
              },
            ],
          },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/kavo-labs/kavo" }],

    search: {
      provider: "local",
    },

    footer: {
      copyright: `Built by the Kavo community`,
    },
  },
});

const mermaidConfig = withMermaid(config);

// vitepress-plugin-mermaid asks Vite to pre-bundle these five transitive
// dependencies of mermaid by bare name. pnpm does not hoist them to the
// workspace root, so `vitepress dev` cannot resolve them and serves a blank
// page. Dropping them from the list lets Vite discover them on demand from
// inside mermaid's own package, where they do resolve. The production build
// resolves through the real dependency graph and never needed the hint.
const PRE_BUNDLED_BY_PLUGIN = ["@braintree/sanitize-url", "dayjs", "debug", "cytoscape-cose-bilkent", "cytoscape"];

export default {
  ...mermaidConfig,
  vite: {
    ...mermaidConfig.vite,
    optimizeDeps: {
      ...mermaidConfig.vite?.optimizeDeps,
      include: (mermaidConfig.vite?.optimizeDeps?.include ?? []).filter((dep) => !PRE_BUNDLED_BY_PLUGIN.includes(dep)),
    },
  },
};
