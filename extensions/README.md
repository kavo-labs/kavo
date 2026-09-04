# Kavo developer skills (Claude Code)

[Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills)
documenting how to _use_ the `@kavo/*` packages in your own app — as opposed
to this repo's own `.claude/skills/`, which covers contributing to Kavo
itself. Point Claude Code at one of these and it has the config shapes,
routes, and grammar memorized instead of guessing from source.

Core surface — these apply whatever ORM you are on:

| Skill                    | Covers                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `quick-start`            | New project from scratch — install, minimal entity, zero-config `@Kavo` (TypeORM)                                                 |
| `kavo-decorator`         | `@Kavo(Entity, config?)` — routes, `EntityConfig`, allowed, relations, overrides                                                  |
| `global-config`          | `KavoSettings` precedence chain, `KavoModule.forRoot`/`createKavo` wiring                                                         |
| `query-grammar`          | The `filter`/`sort`/`fields`/pagination/`include` wire grammar                                                                    |
| `dto-slots`              | The six optional DTO slots and entity-derived defaults                                                                            |
| `error-handling`         | Exception hierarchy, `KAVO_*` codes, the problem-details wire shape                                                               |
| `soft-delete`            | Soft delete / restore / purge strategy and semantics                                                                              |
| `policy`                 | Policy authorization DSL — `permission`/`role`/`owner`/`authenticated`/`filtered`/`when`                                          |
| `composite-primary-keys` | Composite primary keys (`@kavo/typeorm` only) — route-id encoding, creatable/updatable split, and every place they don't yet work |

Per-ORM wiring — read the one matching your project. Only the entity
declaration and the `createInfrastructure` call differ between them:

| Skill              | Covers                                                                         |
| ------------------ | ------------------------------------------------------------------------------ |
| `quick-start`      | **TypeORM** — the decorated entity class is the identity                       |
| `prisma-adapter`   | Marker classes (no runtime class exists), `datamodel`/`entities` options       |
| `mongoose-adapter` | The model _is_ the entity, `ObjectId` → hex string, `ref` as relation _and_ FK |
| `mikroorm-adapter` | Pass the `MikroORM` instance, opt-in `ilike`, no `RequestContext` needed       |

Other protocols:

| Skill             | Covers                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| `graphql-binding` | `@kavo/graphql` and its Nest binding                                       |
| `mcp-binding`     | `@kavo/mcp` — the standard toolset, and the unguarded default `POST /mcp`  |
| `swagger`         | Optional `@nestjs/swagger` integration — what's auto-documented vs. manual |

## Install

This directory is also a Claude Code **plugin** (`.claude-plugin/plugin.json`),
listed in this repo's own marketplace catalog
(`/.claude-plugin/marketplace.json`). Inside Claude Code:

```
/plugin marketplace add kavo-labs/kavo
/plugin install kavo-skills@kavo-marketplace
```

Update later with:

```
/plugin marketplace update kavo-marketplace
```

### Manual install (no plugin support)

One command, from your project root — pulls every skill straight from
GitHub into `.claude/skills/`, no npm publish step and no clone required:

```bash
npx degit kavo-labs/kavo/extensions/skills .claude/skills --force
```

`--force` lets this merge into an existing, non-empty `.claude/skills/`
directory without touching your own skills — `degit` only writes the files
it's pulling, it never deletes anything already there.

Re-run the same command any time to pick up updates.

### Installing a single skill

```bash
npx degit kavo-labs/kavo/extensions/skills/quick-start .claude/skills/quick-start --force
```

Swap `quick-start` for any name from the table above.

## Updating this directory

These are hand-written references, not generated docs — when a `@kavo/*`
package's behavior changes, update the matching `SKILL.md` here in the same
PR (this repo's own `add-config-key`/`add-operation`/etc. skills already
call this out where it applies).
