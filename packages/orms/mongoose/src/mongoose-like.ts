/**
 * The minimal structural shapes this adapter needs from Mongoose — a
 * connection's model registry, a model's schema metadata, and the handful
 * of query methods the adapter calls.
 *
 * Kept structural (not `import type { Model } from "mongoose"`) for the
 * same reason `@kavo/prisma` keeps its client shape structural: an ORM
 * adapter should not force its own build to resolve the peer's types, and
 * `@kavo/core` must never see an ORM type leak through this package's
 * public surface.
 *
 * The seam between the public API and these types is deliberately narrow:
 * {@link MongooseConnectionLike} — the one shape callers hand in — asks for
 * nothing but a `models` record of `unknown`, so a real `mongoose.connection`
 * (or the `mongoose` instance itself) assigns with no cast at all. Every
 * richer shape below is reached only *after* {@link isModelLike} has checked
 * it at runtime, which is why none of them has to win a structural
 * assignability contest against Mongoose's heavily-overloaded generics.
 */

/**
 * What a caller passes to `createInfrastructure`: anything carrying
 * a model registry. Both `mongoose` and `mongoose.connection` satisfy this,
 * as does a `mongoose.createConnection()` handle.
 *
 * This registry is what makes marker classes unnecessary here (contrast
 * ADR-0017 for Prisma): a relation's `ref: "Author"` resolves back to the
 * `Author` model through it, so there is no caller-declared `entities` list.
 */
export interface MongooseConnectionLike {
  readonly models: Readonly<Record<string, unknown>>;
}

/** One `schema.paths[...]` entry — a Mongoose `SchemaType`. */
export interface MongooseSchemaTypeLike {
  /** `"String"`, `"Number"`, `"ObjectId"`, `"Array"`, `"Embedded"`, … */
  readonly instance?: string;
  readonly isRequired?: boolean;
  /** Non-empty only for a path declared with `enum`. */
  readonly enumValues?: readonly string[];
  readonly options?: MongooseSchemaTypeOptions;
  /** Element type of an array path (`[String]`, `[{ type: ObjectId, ref }]`). */
  readonly caster?: {
    readonly instance?: string;
    readonly options?: MongooseSchemaTypeOptions;
  };
}

export interface MongooseSchemaTypeOptions {
  /** Target model name of a `ref` path — the relation edge. */
  readonly ref?: unknown;
  /** `true` on `_id`: Mongoose generates the value. */
  readonly auto?: unknown;
  readonly default?: unknown;
  /**
   * `false` marks a path Mongoose never returns unless asked for by name —
   * where a password hash or API key lives. Kavo leaves such paths out of
   * the entity description entirely (see `isHiddenField` in `metadata.ts`).
   */
  readonly select?: unknown;
}

/** Custom `timestamps` field names (`{ createdAt: "created_at" }`). */
export interface MongooseTimestampOptions {
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export interface MongooseSchemaOptionsLike {
  readonly timestamps?: boolean | MongooseTimestampOptions;
  /** Defaults to `__v`; `false` disables the version key entirely. */
  readonly versionKey?: string | boolean;
}

export interface MongooseSchemaLike {
  readonly paths: Readonly<Record<string, MongooseSchemaTypeLike>>;
  readonly options: MongooseSchemaOptionsLike;
}

/**
 * The query surface the adapter drives. Every read passes `lean: true`, so
 * these resolve to plain objects rather than hydrated documents — with one
 * exception: `create` has no lean mode and returns a document, which
 * {@link toPlainDocument} normalizes.
 *
 * Options objects are used throughout (`find(filter, null, { sort, skip,
 * limit, populate })`) rather than Mongoose's fluent chain, so the shape
 * this package depends on stays six methods wide instead of a whole
 * `Query` builder.
 */
export interface MongooseModelLike {
  readonly modelName: string;
  readonly schema: MongooseSchemaLike;
  find(
    filter: Record<string, unknown>,
    projection: null,
    options: Record<string, unknown>,
  ): PromiseLike<readonly unknown[]>;
  findOne(filter: Record<string, unknown>, projection: null, options: Record<string, unknown>): PromiseLike<unknown>;
  countDocuments(filter: Record<string, unknown>): PromiseLike<number>;
  create(doc: Record<string, unknown>): PromiseLike<unknown>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): PromiseLike<unknown>;
  deleteOne(filter: Record<string, unknown>): PromiseLike<unknown>;
}

/**
 * Runtime check that a value is a Mongoose model. This is the guard that
 * lets every type above stay a plain description instead of a structural
 * contract Mongoose's generics would have to satisfy — and it is also what
 * turns "you passed something that isn't a model" into a
 * `ConfigurationException` naming the entity, rather than a `TypeError`
 * deep inside a query.
 */
export function isModelLike(value: unknown): value is MongooseModelLike {
  if (typeof value !== "function" && typeof value !== "object") {
    return false;
  }
  if (value === null) {
    return false;
  }
  const candidate = value as Partial<MongooseModelLike>;
  return (
    typeof candidate.modelName === "string" &&
    typeof candidate.schema === "object" &&
    candidate.schema !== null &&
    typeof candidate.find === "function"
  );
}
