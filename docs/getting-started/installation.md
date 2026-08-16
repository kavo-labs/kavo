# Installation

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/nest @kavo/typeorm
```

```bash [npm]
npm install @kavo/core @kavo/nest @kavo/typeorm
```

```bash [yarn]
yarn add @kavo/core @kavo/nest @kavo/typeorm
```

```bash [bun]
bun add @kavo/core @kavo/nest @kavo/typeorm
```

:::

- `@kavo/core` — the engine.
- `@kavo/nest` — generates the NestJS routes.
- `@kavo/typeorm` — adapts Kavo to a TypeORM `DataSource`. See [TypeORM](/integrations/orms/typeorm) for the full wiring.

## Peer dependencies

Kavo does not bundle your framework or your ORM. You install those yourself. A Nest app already has most of what `@kavo/nest` needs, and `@kavo/core` needs nothing at all.

Some peers are optional. For example, `@kavo/nest` only needs `graphql` if you use the GraphQL controller, and only needs the MCP SDK if you use the MCP controller. A REST-only install skips both.

See [Peer dependencies](/reference/peer-dependencies) for the full version table.

## GraphQL and MCP

The same entities can be served over GraphQL and the Model Context Protocol, through the same engine. Both are optional and install separately from REST: see [GraphQL](/integrations/protocols/graphql#installing-it) and [MCP](/integrations/protocols/mcp#installing-it) for the install commands and setup.
