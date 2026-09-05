# Migrating relation config from before v0.10

Before v0.10, `relations.edges.<name>.includable: true` was how you opted a relation into `include=`. Naming a relation in `edges` at all, with no `includable` key, opened it by default. That key is gone ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).

To migrate:

1. Move each opted-in relation name to `allowed.includable` (see [Allowed](/features/allowed)).
2. Keep any `maxDepth` or `strategy` on `relations.edges.<name>` exactly where it was.

`allowed.includable` is entity-scope-only config; there's no global `defaults` and no per-operation override. So a permission that used to come from a global default now needs its own `createCrud`/`@Kavo` registration per entity.

## `defaultInclude` moved again, in v0.18 (issue #375)

`relations.edges.<name>.defaultInclude` — the per-relation boolean this guide's earlier revisions covered — is also gone now, replaced by a flat `defaults.include` list ([ADR-0046](/internals/adr/0046-defaults-block-for-omitted-query-axes)): `relations.edges.posts.defaultInclude: true` becomes `defaults: { include: ["posts"] }`, alongside the same `allowed.includable` grant as before.

## `defaults.include` at global scope needs extra care

`allowed.includable` cannot be set globally — it is entity-scope-only config, same as before. A global `defaults.include: ["posts"]` with no entity-level `allowed.includable` naming that relation crashes at bootstrap (`ConfigurationException`) on every entity that has a relation of that name. It is not a silent no-op.

Move `defaults.include` down to each entity's own `defaults`, alongside that entity's `allowed.includable` grant, instead of leaving it at global scope.
