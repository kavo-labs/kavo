import { ChildEntity, Column } from "typeorm";
import { Pet } from "../pet/pet.entity.js";

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
}
