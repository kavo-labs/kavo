<p align="center">
  <img src=".github/assets/intro.png" alt="A @Kavo-decorated BooksController generates QUERY /books, POST /books, GET /books/:id, PUT /books/:id, DELETE /books/:id, and PATCH /books/:id/restore" />
</p>

<h3 align="center">Turn models into APIs.</h3>

<p align="center">
  Define an entity once and get a complete REST and
  GraphQL CRUD API with filtering, sorting, pagination, and generated routes.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kavo/core"><img src="https://img.shields.io/npm/v/%40kavo%2Fcore?label=npm" alt="Latest version on npm" /></a>
  <a href="https://github.com/kavo-labs/kavo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/check-runs/kavo-labs/kavo/main?nameFilter=build%20(node%20lts%2F*)&label=build" alt="Build status on main" /></a>
  <a href="https://github.com/kavo-labs/kavo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/check-runs/kavo-labs/kavo/main?nameFilter=test%20(node%20lts%2F*)&label=tests" alt="Test status on main" /></a>
  <a href="https://github.com/kavo-labs/kavo/blob/main/LICENSE"><img src="https://img.shields.io/github/license/kavo-labs/kavo?label=license" alt="Apache-2.0 licensed" /></a>
  <a href="https://www.npmjs.com/package/@kavo/core"><img src="https://img.shields.io/npm/dm/%40kavo%2Fcore?label=downloads" alt="Downloads per month on npm" /></a>
  <a href="https://kavo.js.org"><img src="https://img.shields.io/badge/docs-kavo.js.org-1f6feb" alt="Documentation" /></a>
</p>

# Kavo

Define an entity once, add one decorator, and Kavo generates the rest: create,
read, update, delete, filtering, sorting, pagination, nested includes, and
field selection — no hand-written controller methods.

[Read documentation](https://kavo.js.org/getting-started)

## Getting started

**pnpm**

```bash
pnpm add @kavo/core @kavo/nest @kavo/typeorm
```

**npm**

```bash
npm install @kavo/core @kavo/nest @kavo/typeorm
```

**yarn**

```bash
yarn add @kavo/core @kavo/nest @kavo/typeorm
```

**bun**

```bash
bun add @kavo/core @kavo/nest @kavo/typeorm
```

`@kavo/nest` expects `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, and
`rxjs` as peers, and `@kavo/typeorm` expects `typeorm` — a Nest app already has
the first four. Kavo needs Node 22+, an ESM app, and `emitDecoratorMetadata`;
see [Requirements](https://kavo.js.org/getting-started#requirements) and
[Peer dependencies](https://kavo.js.org/getting-started#peer-dependencies) for
the exact versions.

```ts
@Kavo(Book)
@Controller("books")
export class BooksController {}
```

That's a full CRUD API. See [kavo.js.org/getting-started](https://kavo.js.org/getting-started)
for the full walkthrough, including NestJS wiring and a soft-delete example.

## Built for agentic development

Built with Claude Code, and shipped with skills so your agent moves just as
fast. [`extensions`](extensions) has ready-made skills for the whole surface —
`@Kavo()`, global config, the query grammar, DTOs, errors, soft delete,
Swagger, the GraphQL and MCP bindings, and per-ORM wiring for each supported
adapter — published as a plugin via this repo's own marketplace:

```
/plugin marketplace add kavo-labs/kavo
/plugin install kavo-skills@kavo-marketplace
```

Fewer tokens, ship faster.

## Packages

| Package                                       | Role                                                        |
| --------------------------------------------- | ----------------------------------------------------------- |
| [`@kavo/core`](packages/core)                 | Contracts, type system, and the request engine              |
| [`@kavo/typeorm`](packages/orms/typeorm)      | TypeORM adapter                                             |
| [`@kavo/prisma`](packages/orms/prisma)        | Prisma adapter                                              |
| [`@kavo/mongoose`](packages/orms/mongoose)    | Mongoose adapter                                            |
| [`@kavo/mikroorm`](packages/orms/mikroorm)    | MikroORM adapter                                            |
| [`@kavo/nest`](packages/frameworks/nest)      | NestJS binding — the `@Kavo` decorator and route generation |
| [`@kavo/graphql`](packages/protocols/graphql) | Host-agnostic GraphQL schema binding                        |
| [`@kavo/mcp`](packages/protocols/mcp)         | Host-agnostic MCP binding — entities as MCP tools           |

Pick the ORM and framework/protocol bindings you need; `@kavo/core` has zero
runtime dependencies.

## Contributing

Bug reports, issues, and pull requests are welcome.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers getting a working checkout, the
`pnpm check` gate every change has to pass, and the architectural invariants a
PR needs to respect.
