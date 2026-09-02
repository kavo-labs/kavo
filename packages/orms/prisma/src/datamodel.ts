/**
 * The subset of Prisma's DMMF (`Prisma.dmmf.datamodel`) this adapter reads.
 * Modeled locally rather than imported from `@prisma/client` or
 * `@prisma/generator-helper`, for the same reason as {@link
 * PrismaClientLike}: `Prisma.dmmf` is a stable, documented runtime export
 * (the mechanism Prisma's own generator ecosystem — `zod-prisma`,
 * `prisma-erd-generator`, and others — relies on to read a schema without
 * a generated client), but its *type* only resolves post-generation. A
 * duck-typed subset keeps `@kavo/prisma` buildable without one, and the
 * real `Prisma.dmmf.datamodel` a consumer passes in satisfies this
 * structurally.
 */
export interface PrismaDatamodel {
  readonly models: readonly PrismaModel[];
  readonly enums: readonly PrismaEnum[];
}

export interface PrismaModel {
  readonly name: string;
  readonly fields: readonly PrismaField[];
}

export interface PrismaEnum {
  readonly name: string;
  readonly values: readonly { readonly name: string }[];
}

/**
 * One field of a DMMF model. `kind: "object"` is a relation edge (Prisma's
 * term for it, not core's `FieldKind`); every other kind is a scalar
 * column. `default` is a literal (`"active"`, `42`) for an ordinary
 * column default, or an object (`{ name: "autoincrement", args: [] }`,
 * `{ name: "now", args: [] }`) for a function-style default Prisma or the
 * database computes at write time — that shape distinction is what
 * separates a merely-defaulted column from a generated one, mirroring
 * `@kavo/typeorm`'s `isGenerated || isCreateDate || …` union.
 */
export interface PrismaField {
  readonly name: string;
  readonly kind: "scalar" | "object" | "enum" | "unsupported";
  readonly type: string;
  readonly isId: boolean;
  readonly isList: boolean;
  readonly isRequired: boolean;
  /**
   * For a `kind: "object"` relation field, the scalar fields on *this*
   * model that hold the foreign key — non-empty on the owning side, empty
   * on the inverse side. Used only to reject `strategy: "key"` on an
   * inverse relation.
   */
  readonly relationFromFields?: readonly string[];
  readonly isUpdatedAt?: boolean;
  readonly hasDefaultValue: boolean;
  readonly default?: unknown;
}
