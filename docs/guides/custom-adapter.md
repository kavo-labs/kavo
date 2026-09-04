# Custom adapter

Kavo ships adapters for TypeORM, Prisma, Mongoose, and MikroORM. For anything else (an unsupported ORM, a non-ORM data source, a read replica with its own routing), the engine talks to persistence through one seam, and implementing it is what plugs a new backend in. `@kavo/core` never imports an ORM; every adapter package lives entirely behind this interface.

## The seam: `RepositoryAdapter`

```ts
interface RepositoryAdapter<Entity, Id> extends EntityReader<Entity, Id>, EntityWriter<Entity, Id> {}
```

Split into a read half and a write half so a read-only consumer can depend on just one:

```ts
interface EntityReader<Entity, Id> {
  findOneById(
    id: Id,
    query: NormalizedQueryContext<Entity> | null,
    context: KavoContext<Entity>,
  ): Promise<Entity | null>;
  findOne(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<Entity | null>;
  findMany(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<readonly Entity[]>;
  count(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<number>;
}

interface EntityWriter<Entity, Id> {
  create(data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity>;
  update(id: Id, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity>;
  patch(id: Id, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity>;
  delete(id: Id, context: KavoContext<Entity>): Promise<void>;
  restore(id: Id, context: KavoContext<Entity>): Promise<Entity>;
  purge(id: Id, context: KavoContext<Entity>): Promise<void>;
  // Optional, only needed if you opt a relation into array-mutation writes:
  replaceRelation?(
    id: Id,
    relation: string,
    memberIds: readonly Id[] | null,
    context: KavoContext<Entity>,
  ): Promise<Entity>;
  patchRelation?(
    id: Id,
    relation: string,
    changes: { add: readonly Id[]; remove: readonly Id[] },
    context: KavoContext<Entity>,
  ): Promise<Entity>;
}
```

Every method receives an already-validated, already-normalized query. Allowed, limits, and coercion were all enforced upstream by the engine, so an adapter **translates**, it never re-validates. `context: KavoContext<Entity>` carries the entity's resolved config, the active transaction handle (if any), and everything else a query needs to resolve consistently.

**"Missing vs. error" is the engine's decision, not the adapter's.** A reader returns `null` for a row that doesn't exist; it's the built-in handler that turns that `null` into `NotFoundException`. Don't throw from an adapter for a row that's simply absent.

## The other half: `EntityMetadata`

Kavo also needs an ORM-independent description of the entity (its columns, their kinds, its relations, its primary key) to derive DTO defaults, allowlist defaults, and coerce wire values:

```ts
interface EntityMetadata<Entity> {
  entity: ClassRef<Entity>;
  name: string;
  idField: string;
  fields: readonly FieldMetadata[]; // { name, kind, nullable, generated, enumValues? }
  relations: readonly RelationDescriptor[];
  softDeleteField?: string | null;
}
```

`FieldMetadata.kind` is one of `"string" | "number" | "boolean" | "date" | "enum" | "json"`. It's what the query normalizer uses to coerce a raw query-string value (`?filter[age][gte]=18`) into the right JS type before it ever reaches your adapter.

## Wiring both together

The two seams are packaged as one `KavoInfrastructure`:

```ts
interface KavoInfrastructure {
  metadataFor<Entity extends object>(entity: ClassRef<Entity>): EntityMetadata<Entity>;
  adapterFor<Entity extends object>(entity: ClassRef<Entity>): RepositoryAdapter<Entity>;
}
```

The existing adapters each export a `createInfrastructure(client, options?)` that builds both from the underlying ORM's own metadata, cached per entity. That's the function an app passes to `KavoModule.forRoot({ infrastructure: ... })` or `createKavo({ infrastructure: ... })`. A new adapter package's job is providing the equivalent: read whatever metadata your backend already has (a schema definition, a table description, a hand-written mapping, whatever's authoritative), translate it into `EntityMetadata`, and implement `RepositoryAdapter` against your backend's own query facility.

## What you don't have to implement

- **Filter/sort/pagination validation** is already done before your adapter sees the query. You only need to translate an already-valid `NormalizedQueryContext` into your backend's native query shape.
- **Soft delete's routing decision** happens in the engine, which resolves the effective strategy (soft vs. hard) from config. Your adapter's `delete`/`restore`/`purge` methods just need to honor `context.config.softDelete` when deciding how to act. See [Soft delete](/features/soft-delete).
- **Array-mutation writes.** `replaceRelation`/`patchRelation` are optional. An adapter that doesn't implement them simply doesn't support that feature. `createCrud` checks for the method at bootstrap the moment a relation opts into `write`, and fails fast with a clear `ConfigurationException` rather than at request time.
- **Transactions.** `context.transaction` is an opaque handle a caller may pass through. Without an adapter supplying one, writes are simply non-transactional. Nothing in the engine requires it.

## Testing without any real backend at all

Because the engine only ever talks to `RepositoryAdapter`/`EntityMetadata`, it's fully testable with an in-memory fake and no ORM anywhere. This is how `@kavo/core`'s own test suite exercises `KavoEngine` (`core/tests/engine.spec.ts`). Building a fake adapter first, before wiring a real backend, is a reasonable way to validate your `EntityMetadata` translation in isolation.

See [core contracts](/internals/architecture/03-core-contracts-and-type-system) for the complete contract inventory, and any existing adapter's architecture doc (e.g. [TypeORM adapter](/internals/architecture/09-typeorm-adapter)) for a worked example of translating a real ORM's metadata and query builder into this seam.
