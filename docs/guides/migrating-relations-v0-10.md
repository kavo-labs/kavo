# Migrating relation config from before v0.10

Before v0.10, `relations.edges.<name>.includable: true` was how you opted a relation into `include=`. Naming a relation in `edges` at all, with no `includable` key, opened it by default. That key is gone ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).

To migrate:

1. Move each opted-in relation name to `allowlists.includable` (see [Allowlists](/features/allowlists)).
2. Keep any `maxDepth` or `strategy` on `relations.edges.<name>` exactly where it was.

`allowlists.includable` is entity-scope-only config; there's no global `defaults` and no per-operation override. So a permission that used to come from a global default now needs its own `createCrud`/`@Kavo` registration per entity.

## `defaultInclude` at global scope needs extra care

Before this change, naming a relation in a global `defaults.relations.edges.<name>` was itself the opt-in, so a global `defaultInclude: true` was safe by construction.

It is not safe to leave where it was. `allowlists.includable` cannot be set globally, so a global `defaultInclude: true` with no entity-level `allowlists.includable` naming that relation now crashes at bootstrap (`ConfigurationException`) on every entity that has a relation of that name. It is not a silent no-op.

Move `defaultInclude: true` down to each entity's own `relations.edges.<name>`, alongside that entity's `allowlists.includable` grant, instead of leaving it at global scope.
