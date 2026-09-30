# kavo-security-testkit

Kavo's shared security conformance suite (#491). **Private, never published**, and never versioned by release-please. `tests/release-workflow.spec.ts` pins both.

One corpus of attacks, written once, that every ORM adapter and every protocol surface runs through its own driver. An adapter or surface inherits the whole threat model the day it wires one up.

## What it contains

| Export                                 | Role                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `defineSecuritySuite(options)`         | Registers the corpus as vitest cases against one driver                                                                       |
| `SecurityDriver`                       | The seam a consumer implements: run a registry operation through a surface, return what a client sees                         |
| `VAULT_CONFIG`, `vaultConfig(idField)` | The entity config every driver runs under                                                                                     |
| `Vault`, `vaultMetadata`               | The fixture entity, for drivers without an ORM                                                                                |
| `MemoryVaultAdapter`                   | An in-memory `RepositoryAdapter` for surfaces whose tests run without a database                                              |
| `engineDriver(service)`                | The adapter-layer driver: `engine.execute` with a `WireQuery`, no HTTP                                                        |
| `toProgrammaticQuery(query)`           | Translates a case's wire query into GraphQL's and MCP's structured `filter`/`sort`; anything with no such spelling is skipped |

The suite's source may import `@kavo/core` and `vitest` only (`.dependency-cruiser.cjs`, `security-testkit-imports-core-and-vitest-only`). Drivers live in each consuming package's `tests/`. Consumers import the entry point `kavo-security-testkit` only, resolved through the `vitest.config.ts` alias and each consumer's `tsconfig.tests.json` `paths`.

## Who runs it

| Layer   | Consumer                                                          | Storage                    |
| ------- | ----------------------------------------------------------------- | -------------------------- |
| Adapter | `packages/core/tests/security-conformance.spec.ts`                | `MemoryVaultAdapter`       |
| Adapter | `packages/orms/typeorm/tests/security-conformance.spec.ts`        | SQLite                     |
| Adapter | `packages/orms/mikroorm/tests/security-conformance.spec.ts`       | SQLite                     |
| Adapter | `packages/orms/prisma/tests/security-conformance.spec.ts`         | SQLite (`Vault` model)     |
| Adapter | `packages/orms/mongoose/tests/security-conformance.spec.ts`       | MongoDB (in-memory server) |
| Surface | `packages/frameworks/nest/tests/security-conformance.e2e.spec.ts` | REST over HTTP             |
| Surface | `packages/frameworks/next/tests/security-conformance.spec.ts`     | App Router handlers        |
| Surface | `packages/protocols/graphql/tests/security-conformance.spec.ts`   | GraphQL documents          |
| Surface | `packages/protocols/mcp/tests/security-conformance.spec.ts`       | MCP tool calls             |

`@kavo/sse` has no driver: it exposes no CRUD operation to drive.

## Adding a case

Name it for the attack and the guarantee (`rejects a column hidden from sort.fields with a 400`) and give it a `SecurityCaseId`. A case that only the wire grammar can express skips itself for `grammar: "programmatic"` drivers. A consumer that fails a case for a tracked reason lists it in `knownGaps` with the public issue number. The case then shows as skipped with that reference, and the entry is deleted when the issue closes.

A reproduction for an unreleased Critical/High finding never enters the corpus before its advisory is published (#490's confidentiality rules).
