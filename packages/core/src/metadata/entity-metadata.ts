import type { ClassRef } from "../types/utility.js";
import type { RelationDescriptor } from "../relations/relation-descriptor.js";
import type { RepositoryAdapter } from "../persistence/repository-adapter.js";

/**
 * ORM-independent description of one entity column's type, used for wire
 * value coercion and DTO default derivation. `json`
 * covers embedded/serialized objects; coercion leaves them untouched.
 */
export type FieldKind = "string" | "number" | "boolean" | "date" | "enum" | "json";

/** One scalar column of an entity. Relations are *not* fields. */
export interface FieldMetadata {
  readonly name: string;
  readonly kind: FieldKind;
  readonly nullable: boolean;
  /**
   * Database-generated (auto-increment ids, `@CreateDateColumn`, …) —
   * excluded from the derived `create`/`update`/`patch` defaults and
   * stripped from write payloads by the default deserializer.
   */
  readonly generated: boolean;
  /** Allowed values when `kind` is `enum` — the coercion allowlist. */
  readonly enumValues?: readonly string[];
}

/**
 * The ORM-independent entity description every adapter package supplies
 * (from its ORM's own metadata) and core consumes for DTO derivation,
 * allowlist defaults, and query-value coercion. This is the seam that
 * keeps `@kavo/core` free of ORM imports while still being
 * metadata-driven.
 */
export interface EntityMetadata<Entity = unknown> {
  readonly entity: ClassRef<Entity>;
  /** Entity name used in errors and debug output (`"User"`). */
  readonly name: string;
  /**
   * Property name of the primary identifier. For a composite-key entity
   * (`compositeIdFields` set) this is the first declared key column —
   * kept for adapters/debug output that still want a single name, but
   * every seam that has to address the row's real identity reads
   * `compositeIdFields` instead when it is present.
   */
  readonly idField: string;
  /**
   * The full ordered list of primary-key columns for a composite-key
   * entity (issue #261, `@kavo/typeorm` only as of v6.1) — `undefined`
   * for the single-key case, which is unaffected by this field's
   * existence. Declaration order is significant: it is the order route
   * ids encode/decode in (`encodeCompositeId`/`decodeCompositeId`) and the
   * order the forced sort tiebreaker composes.
   */
  readonly compositeIdFields?: readonly string[];
  readonly fields: readonly FieldMetadata[];
  readonly relations: readonly RelationDescriptor[];
  /**
   * The delete-marker column the ORM itself declares (`@DeleteDateColumn`
   * in `@kavo/typeorm`), or `null`/absent when it declares none. This is
   * the detection half of the soft-delete strategy resolution; explicit
   * `softDelete.field` configuration wins over it.
   */
  readonly softDeleteField?: string | null;
}

/**
 * What a Kavo root instance needs from an ORM integration: metadata and a
 * repository adapter per entity. `@kavo/typeorm` exports
 * `createInfrastructure(dataSource)`; a test can hand in an
 * in-memory fake. Passed to `createKavo` once — individual `createCrud`
 * calls may still override the adapter per entity.
 */
export interface KavoInfrastructure {
  metadataFor<Entity extends object>(entity: ClassRef<Entity>): EntityMetadata<Entity>;
  adapterFor<Entity extends object>(entity: ClassRef<Entity>): RepositoryAdapter<Entity>;
}
