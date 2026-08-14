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

Kavo never bundles your framework or your ORM. Each package declares what it expects as a peer — a Nest app already has most of them:

- **`@kavo/core`** — none. It has zero runtime dependencies.
- **`@kavo/nest`** — `@nestjs/common` and `@nestjs/core` (`^10.0.0 || ^11.0.0`), `reflect-metadata` (`^0.1.13 || ^0.2.0`), `rxjs` (`^7.8.0`).
- **`@kavo/typeorm`** — `typeorm` (`^0.3.20 || ^1.0.0`).
- **`@kavo/prisma`** — `@prisma/client` (`^5.0.0 || ^6.0.0`).
- **`@kavo/mongoose`** — `mongoose` (`^7.0.0 || ^8.0.0`).
- **`@kavo/mikroorm`** — `@mikro-orm/core` (`^7.0.0`), plus the MikroORM driver package your database needs.
- **`@kavo/graphql`** — `graphql` (`^17.0.0`), optional.
- **`@kavo/mcp`** — `@modelcontextprotocol/sdk` (`^1.0.0`), optional.

Three of `@kavo/nest`'s own peers are declared **optional** — `@nestjs/swagger` (`^8.0.0 || ^11.0.0`) for generated OpenAPI docs, `graphql` (`^17.0.0`) for the GraphQL controller, and `@modelcontextprotocol/sdk` (`^1.0.0`) for the MCP controller — so nothing makes you configure a protocol you don't serve.

Both `@kavo/nest`'s dependency on the binding and the binding's own peer declare the protocol library optional, so a REST-only install pulls in neither `graphql` nor the MCP SDK — you add the protocol library yourself only when you use it.

## GraphQL and MCP

The same entities can be served over GraphQL and the Model Context Protocol, through the same engine.

Inside a Nest app you never install the Kavo bindings directly — `@kavo/nest` depends on both `@kavo/graphql` and `@kavo/mcp`. Add only the protocol library you intend to use:

::: code-group

```bash [pnpm]
pnpm add graphql                    # GraphQL
pnpm add @modelcontextprotocol/sdk  # MCP
```

```bash [npm]
npm install graphql                    # GraphQL
npm install @modelcontextprotocol/sdk  # MCP
```

```bash [yarn]
yarn add graphql                    # GraphQL
yarn add @modelcontextprotocol/sdk  # MCP
```

```bash [bun]
bun add graphql                    # GraphQL
bun add @modelcontextprotocol/sdk  # MCP
```

:::

Both bindings are host-framework-agnostic, so they also work without Nest. Installed that way you add the Kavo package yourself, alongside `@kavo/core` and whichever ORM adapter you use:

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/graphql graphql
pnpm add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash [npm]
npm install @kavo/core @kavo/graphql graphql
npm install @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash [yarn]
yarn add @kavo/core @kavo/graphql graphql
yarn add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash [bun]
bun add @kavo/core @kavo/graphql graphql
bun add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

:::
