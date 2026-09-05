import type { ClassRef, EntityMetadata, FieldKind, FieldMetadata, RelationDescriptor } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import type { DataSource } from "typeorm";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata.js";

/**
 * Translate TypeORM's column type (a constructor or a driver type string)
 * into the ORM-independent `FieldKind` core coerces against. Unrecognized
 * driver strings degrade to `string` — comparison still works, coercion
 * just doesn't narrow.
 */
export function fieldKindOf(column: ColumnMetadata): FieldKind {
  if (column.type === Number) {
    return "number";
  }
  if (column.type === String) {
    return "string";
  }
  if (column.type === Boolean) {
    return "boolean";
  }
  if (column.type === Date) {
    return "date";
  }
  const type = String(column.type).toLowerCase();
  if (type === "enum" || type === "simple-enum") {
    return "enum";
  }
  if (
    /^(int|integer|tinyint|smallint|mediumint|bigint|float|double|double precision|real|decimal|numeric|number)$/.test(
      type,
    )
  ) {
    return "number";
  }
  if (/^(bool|boolean)$/.test(type)) {
    return "boolean";
  }
  if (/^(date|datetime|timestamp|timestamptz|time)($| )/.test(type)) {
    return "date";
  }
  if (/^(json|jsonb|simple-json)$/.test(type)) {
    return "json";
  }
  return "string";
}

/**
 * Build the core `EntityMetadata` for one entity from the DataSource's
 * TypeORM metadata: the adapter feeds core's metadata seam; core
 * never sees TypeORM types.
 */
export function buildEntityMetadata<Entity extends object>(
  dataSource: DataSource,
  entity: ClassRef<Entity>,
): EntityMetadata<Entity> {
  const metadata = dataSource.getMetadata(entity);

  if (metadata.primaryColumns.length === 0) {
    throw new ConfigurationException(
      metadata.name,
      "primaryColumns",
      `Kavo requires at least one primary column; found 0`,
    );
  }
  const primary = metadata.primaryColumns[0]!;
  // A composite key (issue #261) still names `idField` as its first
  // declared column — kept for the callers that only ever need a single
  // name (debug output, `notFound`'s error message) — but every seam that
  // has to address the row's real identity reads `compositeIdFields`
  // instead, whose presence is what actually signals "this entity is
  // composite-keyed" to core.
  const compositeIdFields =
    metadata.primaryColumns.length > 1 ? metadata.primaryColumns.map((column) => column.propertyName) : undefined;

  const fields: FieldMetadata[] = metadata.columns
    .filter((column) => column.relationMetadata === undefined)
    .map((column) => ({
      name: column.propertyName,
      kind: fieldKindOf(column),
      nullable: column.isNullable,
      generated:
        column.isGenerated || column.isCreateDate || column.isUpdateDate || column.isDeleteDate || column.isVersion,
      ...(column.enum !== undefined && {
        enumValues: column.enum.map((value) => String(value)),
      }),
      // `@VirtualColumn({ query })` (issue #373): the column's own `query`
      // function is real SQL — an alias-parameterized fragment TypeORM
      // itself uses to populate the property when the entity is loaded —
      // so it round-trips through core's opaque `derivedExpression` marker
      // and this adapter inlines it into `WHERE`/`ORDER BY`/`SELECT` when a
      // filter, sort, or `select=` names the field (`filter-translator.ts`,
      // `typeorm-repository-adapter.ts`).
      ...(column.query !== undefined && { derivedExpression: column.query }),
    }));

  const relations: RelationDescriptor[] = metadata.relations.map((relation) => ({
    name: relation.propertyName,
    // The *resolved* target class, not `relation.type`: a string-target
    // relation (`@ManyToOne("Owner", …)`, the form that keeps import
    // cycles off the runtime graph) leaves `type` as the entity name, and
    // core matches registered entities by class identity.
    target: () => relation.inverseEntityMetadata.target as ClassRef,
    cardinality: relation.isOneToMany || relation.isManyToMany ? "many" : "one",
    // Owns the FK column iff it is the many-to-one side or the owning side
    // of a one-to-one — the only shapes `strategy: "key"` can read.
    ...(relation.isOneToMany || relation.isManyToMany
      ? {}
      : { ownsForeignKey: relation.isManyToOne || relation.isOneToOneOwner }),
    // Inclusion is an opt-in allowlist; ORM metadata only
    // supplies shape, never permission.
    includable: false,
    strategy: "auto",
  }));

  return {
    entity,
    name: metadata.name,
    idField: primary.propertyName,
    ...(compositeIdFields !== undefined && { compositeIdFields }),
    fields,
    relations,
    // `@DeleteDateColumn` detection: the ORM's own declaration
    // is what makes zero-config soft delete work. Explicit
    // `softDelete.field` config still wins over it — core decides, this
    // only reports.
    softDeleteField: metadata.deleteDateColumn?.propertyName ?? null,
  };
}
