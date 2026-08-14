# Configuration

[Nest + TypeORM](/integrations/nest/typeorm), [Nest + Prisma](/integrations/nest/prisma), [Nest + Mongoose](/integrations/nest/mongoose), and [Nest + MikroORM](/integrations/nest/mikroorm) cover the zero-config path. Once zero-config isn't enough, configuration resolves through one precedence chain, each scope overriding the one before it:

```
built-in defaults → global (KavoModule) → entity (@Kavo config) → operation (operations.<id>) → per-call
```

A field you don't set at a given scope just falls through to the next one down. The full merge semantics (deep-merge rules, what "unset" means per field) are in [Configuration](/internals/architecture/08-configuration) — these pages document what each field means and where you can set it:

- **[Module setup](/integrations/nest/configuration/module-setup)** — `KavoModule.forRoot`/`forRootAsync`, and the `principal` extractor.
- **[Settings](/integrations/nest/configuration/settings)** — the app-wide `KavoSettings` fields: pagination, query, errors, relations, arrayMutation, caching, softDelete, realtime.
- **[Entity config](/integrations/nest/configuration/entity-config)** — `@Kavo(Entity, config)`'s own fields: `dto`, `allowlists`, `computed`.
- **[Operations](/integrations/nest/configuration/operations)** — per-operation overrides, custom operations, and custom list metadata.
