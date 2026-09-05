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
      { text: "Getting started", link: "/getting-started/introduction" },
      {
        text: "Integrations",
        items: [
          { text: "TypeORM", link: "/integrations/orms/typeorm" },
          { text: "Prisma", link: "/integrations/orms/prisma" },
          { text: "Mongoose", link: "/integrations/orms/mongoose" },
          { text: "MikroORM", link: "/integrations/orms/mikroorm" },
        ],
      },
      { text: "Using the API", link: "/using-the-api" },
    ],

    version,

    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Introduction", link: "/getting-started/introduction" },
          { text: "Requirements", link: "/getting-started/requirements" },
          { text: "Installation", link: "/getting-started/installation" },
          { text: "Quick Start", link: "/getting-started/quick-start" },
        ],
      },
      {
        text: "Core",
        items: [
          { text: "Entities", link: "/core/entities" },
          { text: "CRUD Operations", link: "/core/crud-operations" },
          { text: "DTOs", link: "/core/dtos" },
          { text: "Services", link: "/core/services" },
          { text: "Routes & Controllers", link: "/core/routes-and-controllers" },
          { text: "Custom Operations", link: "/core/custom-operations" },
        ],
      },
      {
        text: "Querying",
        items: [
          { text: "Filtering", link: "/querying/filtering" },
          { text: "Search", link: "/querying/search" },
          { text: "Sorting", link: "/querying/sorting" },
          { text: "Pagination", link: "/querying/pagination" },
          { text: "Field Selection", link: "/querying/field-selection" },
          { text: "Includes", link: "/querying/includes" },
        ],
      },
      {
        text: "Features",
        items: [
          { text: "Relations", link: "/features/relations" },
          { text: "Soft Delete", link: "/features/soft-delete" },
          { text: "Realtime Events", link: "/features/realtime-events" },
          { text: "Caching & ETags", link: "/features/caching-and-etags" },
          { text: "Result Cache", link: "/features/result-cache" },
          { text: "Allowlists", link: "/features/allowlists" },
          { text: "Virtual Fields", link: "/features/virtual-fields" },
          { text: "Policy", link: "/features/policy" },
          { text: "Composite Primary Keys", link: "/features/composite-primary-keys" },
        ],
      },
      {
        text: "Integrations",
        items: [
          {
            text: "ORMs",
            items: [
              { text: "TypeORM", link: "/integrations/orms/typeorm" },
              { text: "Prisma", link: "/integrations/orms/prisma" },
              { text: "Mongoose", link: "/integrations/orms/mongoose" },
              { text: "MikroORM", link: "/integrations/orms/mikroorm" },
            ],
          },
          {
            text: "Protocols",
            items: [
              { text: "GraphQL", link: "/integrations/protocols/graphql" },
              { text: "MCP", link: "/integrations/protocols/mcp" },
            ],
          },
        ],
      },
      {
        text: "Guides",
        items: [
          {
            text: "Configuration",
            link: "/guides/configuration/",
            items: [
              { text: "Module setup", link: "/guides/configuration/module-setup" },
              { text: "Settings", link: "/guides/configuration/settings" },
              { text: "ETag overrides and redaction", link: "/guides/configuration/etag-overrides" },
              { text: "Entity config", link: "/guides/configuration/entity-config" },
              { text: "Operations", link: "/guides/configuration/operations" },
            ],
          },
          { text: "Wiring Your Own Auth", link: "/guides/wiring-your-own-auth" },
          { text: "Error Handling", link: "/guides/error-handling" },
          { text: "Custom Adapter", link: "/guides/custom-adapter" },
          { text: "Migrating Relations Config (pre-v0.10)", link: "/guides/migrating-relations-v0-10" },
          { text: "Using the API", link: "/using-the-api" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Config Keys", link: "/reference/config-keys" },
          { text: "Errors", link: "/reference/errors" },
          { text: "Decorators", link: "/reference/decorators" },
          { text: "Peer Dependencies", link: "/reference/peer-dependencies" },
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
              {
                text: "0027 — An @Override inherits the ETag, but not the precondition",
                link: "/internals/adr/0027-an-override-inherits-the-etag-but-not-the-precondition",
              },
              {
                text: "0028 — Relation inclusion permission moves into allowlists.includable",
                link: "/internals/adr/0028-includable-relations-move-into-allowlists",
              },
              {
                text: "0029 — Array relations may opt into replace writes",
                link: "/internals/adr/0029-array-relations-may-opt-into-replace-writes",
              },
              {
                text: "0030 — 'none' pagination strategy opts a resource out entirely",
                link: "/internals/adr/0030-none-pagination-strategy-opts-a-resource-out-entirely",
              },
              {
                text: "0031 — Result cache is a live per-entity store",
                link: "/internals/adr/0031-result-cache-is-a-live-store-invalidated-wholesale",
              },
              {
                text: "0032 — Policy authorization DSL",
                link: "/internals/adr/0032-policy-authorization-dsl",
              },
              {
                text: "0033 — Policy moves to operation scope only",
                link: "/internals/adr/0033-policy-moves-to-operation-scope-only",
              },
              {
                text: "0034 — when() predicate takes a single object argument",
                link: "/internals/adr/0034-when-predicate-takes-a-single-object-argument",
              },
              {
                text: "0035 — authorization.required denies standard operations with no configured policy",
                link: "/internals/adr/0035-authorization-required-default-deny-switch",
              },
              {
                text: "0036 — policy gains entity- and global-scope defaults",
                link: "/internals/adr/0036-policy-gains-entity-and-global-defaults",
              },
              {
                text: "0037 — policy collapses to a single predicate function, at three scopes",
                link: "/internals/adr/0037-policy-collapses-to-a-single-predicate",
              },
              {
                text: "0038 — Declaring operations at all makes it an exclusive whitelist",
                link: "/internals/adr/0038-declared-operations-is-an-exclusive-whitelist",
              },
              {
                text: "0039 — Composite primary keys, @kavo/typeorm only",
                link: "/internals/adr/0039-composite-primary-keys-are-typeorm-only",
              },
              {
                text: "0040 — Composite primary keys extend to @kavo/prisma",
                link: "/internals/adr/0040-composite-primary-keys-extend-to-prisma",
              },
              {
                text: "0041 — Releases are cut by release-please",
                link: "/internals/adr/0041-releases-are-cut-by-release-please",
              },
              {
                text: "0042 — Filter and Query are documented-only aggregate component schemas",
                link: "/internals/adr/0042-filter-and-query-component-schemas",
              },
              {
                text: "0044 — A relation-dotted allowlists.selectable entry caps an included relation's projection",
                link: "/internals/adr/0044-relation-projection-ceiling-from-selectable",
              },
              {
                text: "0045 — allowlists.selectable takes root paths only; the relation-dotted ceiling is removed",
                link: "/internals/adr/0045-relation-projection-ceiling-removed",
              },
              {
                text: "0046 — Derived fields come from ORM metadata; core stays expression-agnostic",
                link: "/internals/adr/0046-derived-fields-come-from-orm-metadata",
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

export default withMermaid(config);
