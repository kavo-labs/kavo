import { ChildEntity, Column } from "typeorm";
import { Pet } from "../pet/pet.entity.js";

/**
 * Structured payload for the `vitals` JSON column. The concrete type is a
 * compile-time contract only — the TypeORM adapter still maps the column to
 * core's opaque `json` `FieldKind` (derived from the column type, not this
 * interface), so the generated DTO / OpenAPI schema stays an open object and
 * the field remains non-filterable, exactly like `attributes`.
 */
export interface DogVitals {
  weightKg: number;
  heightCm: number;
  lastCheckup: string;
}

/**
 * A concrete Pet subtype. Child columns must be nullable under single-table
 * inheritance (rows of sibling types leave them empty).
 */
@ChildEntity("dog")
export class Dog extends Pet {
  @Column("varchar", { nullable: true })
  breed!: string;

  @Column("boolean", { nullable: true })
  goodBoy!: boolean;

  // A JSON column, demonstrated on `Dog` because it falls back to
  // entity-derived DTOs (no `dto` block, unlike `Cat`) — the field needs no
  // DTO plumbing to round-trip through POST/PUT/PATCH. `simple-json` is
  // TypeORM's driver-agnostic abstraction (stored as text, JSON-serialized
  // by the driver), so the same column works unchanged across sqlite,
  // postgres, mariadb, and cockroachdb — the four drivers this example's
  // e2e suite runs against. The typeorm adapter maps it to core's `json`
  // `FieldKind`, which value-coercion refuses to compare (json columns
  // cannot be filtered).
  @Column("simple-json", { nullable: true })
  attributes!: Record<string, unknown> | null;

  // Same `simple-json` mechanics as `attributes`, but typed to a concrete
  // shape (`DogVitals`) rather than an open record — the app-side value is
  // statically checked, while the wire contract is unchanged.
  @Column("simple-json", { nullable: true })
  vitals!: DogVitals | null;
}
