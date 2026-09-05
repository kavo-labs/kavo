# Configuration

[TypeORM](/integrations/orms/typeorm), [Prisma](/integrations/orms/prisma), [Mongoose](/integrations/orms/mongoose), and [MikroORM](/integrations/orms/mikroorm) cover the zero-config path. When you need more than that, configuration resolves through one precedence chain. Each scope overrides the one before it:

```
built-in defaults → global (KavoModule) → entity (@Kavo config) → operation (operations.<id>) → per-call
```

If you don't set a field at a given scope, it falls through to the next one down. The full merge rules (deep-merge behavior, what "unset" means per field) are in [Configuration](/internals/architecture/08-configuration). `policy` doesn't follow this chain's merge algebra: it resolves nearest-scope-wins across global (`createKavo({ policy })`), entity (`@Kavo` config), and operation (`operations.<id>.policy`) — the nearest scope that defines a function replaces every farther one wholesale rather than merging field-by-field — and has no per-call override at any scope (ADR-0037): a per-call parameter that could loosen a policy would let a caller weaken its own authorization. These pages document what each field means and where to set it:

- **[Module setup](/guides/configuration/module-setup)**: `KavoModule.forRoot`/`forRootAsync`, and the `app` context extractor.
- **[Settings](/guides/configuration/settings)**: the app-wide `KavoSettings` fields: pagination, query, errors, relations, arrayMutation, cache, softDelete, realtime.
- **[Entity config](/guides/configuration/entity-config)**: `@Kavo(Entity, config)`'s own fields: `dto`, `allowlists`, plus where `policy` is set.
- **[Operations](/guides/configuration/operations)**: per-operation overrides, custom operations, and custom list metadata.
