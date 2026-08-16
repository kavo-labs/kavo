# Configuration

[TypeORM](/integrations/orms/typeorm), [Prisma](/integrations/orms/prisma), [Mongoose](/integrations/orms/mongoose), and [MikroORM](/integrations/orms/mikroorm) cover the zero-config path. When you need more than that, configuration resolves through one precedence chain. Each scope overrides the one before it:

```
built-in defaults → global (KavoModule) → entity (@Kavo config) → operation (operations.<id>) → per-call
```

If you don't set a field at a given scope, it falls through to the next one down. The full merge rules (deep-merge behavior, what "unset" means per field) are in [Configuration](/internals/architecture/08-configuration). These pages document what each field means and where to set it:

- **[Module setup](/guides/configuration/module-setup)**: `KavoModule.forRoot`/`forRootAsync`, and the `principal` extractor.
- **[Settings](/guides/configuration/settings)**: the app-wide `KavoSettings` fields: pagination, query, errors, relations, arrayMutation, caching, softDelete, realtime.
- **[Entity config](/guides/configuration/entity-config)**: `@Kavo(Entity, config)`'s own fields: `dto`, `allowlists`, `computed`.
- **[Operations](/guides/configuration/operations)**: per-operation overrides, custom operations, and custom list metadata.
