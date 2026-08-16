# Peer dependencies

The full peer dependency list for every Kavo package, with version ranges. See [Installation](/getting-started/installation) for the short version and the install commands.

## Required peers

| Package          | Peer                                     | Version                |
| ---------------- | ---------------------------------------- | ---------------------- |
| `@kavo/core`     | none                                     |                        |
| `@kavo/nest`     | `@nestjs/common`, `@nestjs/core`         | `^10.0.0 \|\| ^11.0.0` |
| `@kavo/nest`     | `reflect-metadata`                       | `^0.1.13 \|\| ^0.2.0`  |
| `@kavo/nest`     | `rxjs`                                   | `^7.8.0`               |
| `@kavo/typeorm`  | `typeorm`                                | `^0.3.20 \|\| ^1.0.0`  |
| `@kavo/prisma`   | `@prisma/client`                         | `^5.0.0 \|\| ^6.0.0`   |
| `@kavo/mongoose` | `mongoose`                               | `^7.0.0 \|\| ^8.0.0`   |
| `@kavo/mikroorm` | `@mikro-orm/core`, plus your DB's driver | `^7.0.0`               |

`@kavo/core` has no peers at all. It has zero runtime dependencies.

## Optional peers

| Package         | Peer                        | Version               | Needed for             |
| --------------- | --------------------------- | --------------------- | ---------------------- |
| `@kavo/graphql` | `graphql`                   | `^17.0.0`             | the GraphQL binding    |
| `@kavo/mcp`     | `@modelcontextprotocol/sdk` | `^1.0.0`              | the MCP binding        |
| `@kavo/nest`    | `@nestjs/swagger`           | `^8.0.0 \|\| ^11.0.0` | generated OpenAPI docs |
| `@kavo/nest`    | `graphql`                   | `^17.0.0`             | the GraphQL controller |
| `@kavo/nest`    | `@modelcontextprotocol/sdk` | `^1.0.0`              | the MCP controller     |

`@kavo/nest` declares `graphql` and the MCP SDK optional, and so do `@kavo/graphql` and `@kavo/mcp` themselves. Both sides agree, so a REST-only install pulls in neither package. You add `graphql` or the MCP SDK yourself only when you use that protocol. See [GraphQL](/integrations/protocols/graphql#installing-it) and [MCP](/integrations/protocols/mcp#installing-it) for the install commands.
