import type { ClassRef, EntityMetadata, FieldKind, FieldMetadata, RelationDescriptor } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import type { EntityProperty, MikroORM } from "@mikro-orm/core";

/**
 * Translate a MikroORM property's declared type into the ORM-independent
 * `FieldKind` core coerces against.
 *
 * `runtimeType` is preferred over `type`: MikroORM normalizes the former to
 * the JavaScript type the property actually holds (`"string"`, `"Date"`),
 * which is what core must coerce toward — a `decimal` column surfaces as
 * `"string"` there, and `string` is genuinely the right target for it. The
 * declared `type` is still consulted as a fallback, because `runtimeType` is
 * `"any"` for the custom types that carry no JavaScript equivalent
 * (`JsonType`). An unrecognized type degrades to `string` — comparison still
 * works, coercion just doesn't narrow.
 *
 * A `bigint` column is a caveat, not a case this function special-cases: as
 * of MikroORM v7, `BigIntType`'s default mode hands JavaScript a native
 * `bigint`, and `runtimeType` reports that as `"bigint"`, matched below
 * alongside `"number"`. An app that needs the old, precision-safe string
 * representation back must construct the type explicitly —
 * `new BigIntType("string")` — see doc 17 §1.
 */
function fieldKindOf(property: EntityProperty): FieldKind {
  if (property.enum === true) {
    return "enum";
  }
  const type = String(property.runtimeType ?? property.type).toLowerCase();
  if (type === "date") {
    return "date";
  }
  if (type === "boolean" || type === "bool") {
    return "boolean";
  }
  if (type === "number" || type === "bigint") {
    return "number";
  }
  if (type === "string") {
    return "string";
  }
  if (type === "object" || type === "json" || type === "jsonb") {
    return "json";
  }
  // Fall back to the declared column type for anything `runtimeType` did not
  // already answer (a custom `type: "int8"`, a driver-native column type).
  const declared = String(property.type).toLowerCase();
  if (/^(int|integer|tinyint|smallint|mediumint|bigint|float|double|real|decimal|numeric|number)/.test(declared)) {
    return "number";
  }
  if (/^(bool|boolean)/.test(declared)) {
    return "boolean";
  }
  if (/^(date|datetime|timestamp|time)/.test(declared)) {
    return "date";
  }
  if (/^(json|jsonb)/.test(declared)) {
    return "json";
  }
  return "string";
}

/**
 * Whether a property is written by the database or the ORM rather than by
 * the caller — excluded from the derived `create`/`update`/`patch` defaults
 * and stripped from write payloads by the default deserializer.
 *
 * MikroORM has no single flag for this, so the four independent ways a
 * property becomes non-caller-writable are each checked: an auto-increment
 * or database-generated column, an `onCreate`/`onUpdate` hook (the
 * equivalent of TypeORM's `@CreateDateColumn`/`@UpdateDateColumn`), an
 * optimistic-lock `@Property({ version: true })`, and `persist: false`,
 * which is not stored at all.
 */
function isGenerated(property: EntityProperty): boolean {
  return (
    property.autoincrement === true ||
    property.generated !== undefined ||
    property.onCreate !== undefined ||
    property.onUpdate !== undefined ||
    property.version === true ||
    property.persist === false
  );
}

/** MikroORM's relation `kind` discriminators that carry many rows. */
const TO_MANY = new Set(["1:m", "m:n"]);

/**
 * The lazy target-class thunk for one relation.
 *
 * A relation target can be declared two ways, and they do *not* arrive the
 * same: `@ManyToOne(() => Owner)` leaves `property.entity` a thunk resolving
 * to the class, while `@ManyToOne((): any => "Owner")` — the spelling that
 * keeps a bidirectional relation's import cycle off the runtime graph, and
 * therefore the one a `dependency-cruiser`-checked codebase reaches for —
 * leaves it a thunk resolving to a plain **string** (MikroORM v7's decorator
 * types no longer accept a bare string; `any` is what makes the thunk
 * type-check). Calling it would return a string, not a class, for half the
 * codebases that use this adapter.
 *
 * `targetMeta` is what both spellings have in common: MikroORM resolves it
 * during metadata discovery either way. The metadata-storage lookup behind
 * it covers a target discovered after this thunk was built, and the declared
 * thunk is the last resort. The resolution is deferred until the thunk is
 * called, because a bidirectional relation's target may not be registered at
 * the time this entity's metadata is derived.
 */
function targetOf(orm: MikroORM, property: EntityProperty, owner: string): () => ClassRef {
  return () => {
    const resolved =
      property.targetMeta?.class ?? orm.getMetadata().getByClassName(String(property.type), false)?.class;
    if (resolved !== undefined) {
      return resolved as ClassRef;
    }
    if (typeof property.entity === "function") {
      return (property.entity as () => ClassRef)();
    }
    throw new ConfigurationException(
      owner,
      `relations.${property.name}`,
      `cannot resolve the target entity of relation '${property.name}'; ` +
        `MikroORM reports its type as '${String(property.type)}', which is not a registered entity`,
    );
  };
}

/**
 * Build the core `EntityMetadata` for one entity from MikroORM's own
 * `MetadataStorage`: the adapter feeds core's metadata seam; core never sees
 * MikroORM types.
 *
 * Unlike `@kavo/prisma`, no marker class is needed (ADR-0017 exists because
 * Prisma erases its models at compile time) — a MikroORM entity is a real
 * runtime class that already carries its own metadata, so the class the
 * caller passes to `createCrud` *is* the identity, exactly as in
 * `@kavo/typeorm`.
 */
export function buildEntityMetadata<Entity extends object>(
  orm: MikroORM,
  entity: ClassRef<Entity>,
): EntityMetadata<Entity> {
  const metadata = orm.getMetadata().getByClassName<Entity, false>(entity.name, false);
  if (metadata === undefined) {
    throw new ConfigurationException(
      entity.name,
      "entity",
      `MikroORM has no registered entity named '${entity.name}'; ` +
        `add it to the 'entities' array the ORM was initialized with`,
    );
  }

  if (metadata.primaryKeys.length !== 1) {
    throw new ConfigurationException(
      metadata.className,
      "primaryKeys",
      `Kavo v6 requires exactly one primary key; found ${metadata.primaryKeys.length}`,
    );
  }

  const properties = Object.values(metadata.properties) as EntityProperty[];
  const discriminatorColumn = metadata.root?.discriminatorColumn ?? metadata.discriminatorColumn;

  const fields: FieldMetadata[] = properties
    // An embeddable contributes *two* kinds of property: the object-valued
    // parent (`kind: "embedded"`, what a caller addresses) and one child per
    // inner column, carrying an `embedded: [parent, child]` back-reference
    // and a name that is an implementation detail (`addr~city`,
    // `inline_city`). Only the parent belongs on the wire, so the children
    // are dropped rather than leaked into DTOs and allowlists.
    .filter((property) => property.embedded === undefined)
    // `hidden: true` is MikroORM's "never expose this" — `toObject` drops it,
    // so it can never reach a response. Excluding it from the metadata seam
    // as well, rather than relying on that, is what stops it from landing on
    // the *default allowlists*: a filterable-but-invisible column is a blind
    // extraction oracle, where `filter[passwordHash][like]=a%` is answered by
    // the row count even though the value is projected out of the body.
    // `lazy: true` is excluded for the same reason — it is not loaded with
    // the entity, so a DTO naming it would emit `undefined` while a filter on
    // it still ran in the database. `@kavo/mongoose` excludes its
    // `select: false` paths on identical reasoning (doc 15 §1). The trade is
    // the same one it documents: Kavo does not manage such a property at all,
    // so write it through a custom operation or the ORM directly.
    .filter((property) => property.hidden !== true && property.lazy !== true)
    .filter((property) => property.kind === "scalar" || property.kind === "embedded")
    .map((property) => ({
      name: property.name,
      kind: property.kind === "embedded" ? "json" : fieldKindOf(property),
      nullable: property.nullable === true,
      // The single-table-inheritance discriminator: write-only bookkeeping
      // MikroORM manages itself from the subtype being persisted. It never
      // hydrates onto an entity and never survives `toObject`, so it cannot
      // reach a response either way — what this flag stops is the *inbound*
      // direction. Left un-generated it would join the writable projection,
      // and a client sending `species: "cat"` on a Dog would produce a row
      // that entity's own repository can no longer load.
      //
      // Read from `root`, because MikroORM records `discriminatorColumn` only
      // on the inheritance root while the property itself is inherited by
      // every subtype — and a subtype is what a caller passes to `createCrud`.
      generated: isGenerated(property) || property.name === discriminatorColumn,
      ...(property.items !== undefined && {
        enumValues: property.items.map((value) => String(value)),
      }),
    }));

  const relations: RelationDescriptor[] = properties
    .filter((property) => property.kind !== "scalar" && property.kind !== "embedded")
    .map((property) => ({
      name: property.name,
      // Resolved lazily and from `targetMeta` rather than by calling
      // `property.entity` — see `targetOf`, which exists because a
      // string-declared target (the spelling that keeps a bidirectional
      // relation's cycle off the runtime graph) leaves `entity` a string.
      target: targetOf(orm, property, metadata.className),
      cardinality: TO_MANY.has(property.kind) ? ("many" as const) : ("one" as const),
      // Inclusion is an opt-in allowlist; ORM metadata only supplies shape,
      // never permission.
      includable: false,
      strategy: "auto" as const,
    }));

  return {
    entity,
    name: metadata.className,
    idField: metadata.primaryKeys[0]!,
    fields,
    relations,
    // MikroORM declares no delete-date marker of its own — its soft-delete
    // pattern is a user-defined `@Filter`, which is a query concern rather
    // than a column declaration, so there is nothing here to detect.
    //
    // This is *not* the same as "soft delete is off until configured".
    // `softDelete` defaults to `{ field: "deletedAt", strategy: "auto" }`, and
    // core matches that name against the entity's own columns — so a plain
    // `deletedAt` property enables soft delete with no config at all. What
    // reporting `null` here really costs is the ability to mark the marker
    // generated, which is why it stays client-writable. See doc 17 §5 and §7.
    softDeleteField: null,
  };
}
