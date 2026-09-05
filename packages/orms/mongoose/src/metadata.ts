import type { ClassRef, EntityMetadata, FieldKind, FieldMetadata, RelationDescriptor } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import {
  isModelLike,
  type MongooseConnectionLike,
  type MongooseModelLike,
  type MongooseSchemaLike,
  type MongooseSchemaTypeLike,
} from "./mongoose-like.js";

/** MongoDB's primary key is always `_id`; there is no other choice to make. */
const ID_FIELD = "_id";

/**
 * Mongoose `SchemaType.instance` → core's ORM-independent `FieldKind`.
 *
 * `ObjectId` maps to `string` because that is what leaves this adapter (see
 * `plain-document.ts`) — including `_id` itself, which is why an entity's id
 * is a `string` on the wire and `EntityId` never had to grow a third member.
 * An unrecognized instance degrades to `string`, the same fallback posture
 * as `@kavo/typeorm` and `@kavo/prisma`.
 */
function fieldKindOf(schemaType: MongooseSchemaTypeLike): FieldKind {
  if ((schemaType.enumValues?.length ?? 0) > 0) {
    return "enum";
  }
  const instance = schemaType.instance === "Array" ? schemaType.caster?.instance : schemaType.instance;
  switch (instance) {
    case "Number":
    case "Decimal128":
    case "BigInt":
      return "number";
    case "Boolean":
      return "boolean";
    case "Date":
      return "date";
    case "Mixed":
    case "Embedded":
    case "Map":
    case "Buffer":
      return "json";
    default:
      return "string";
  }
}

/**
 * A path is "generated" (excluded from `create`/`update`/`patch` DTO
 * defaults and stripped from write payloads) when Mongoose or MongoDB
 * supplies its value rather than the caller:
 *
 * - `_id`, which carries `auto: true`;
 * - the `timestamps` pair, whether default-named or renamed;
 * - a **function** default (`default: Date.now`), which is computed per
 *   write. A literal default (`default: "active"`, `default: null`) is an
 *   ordinary writable field with a fallback, exactly as in `@kavo/prisma` —
 *   note that `default: null` is an *object*, so the test has to be for a
 *   function specifically, not for non-primitiveness.
 */
function isGeneratedField(path: string, schemaType: MongooseSchemaTypeLike, timestamps: ReadonlySet<string>): boolean {
  if (schemaType.options?.auto === true) {
    return true;
  }
  if (timestamps.has(path)) {
    return true;
  }
  return typeof schemaType.options?.default === "function";
}

/**
 * A path the schema author marked `select: false` — Mongoose's own way of
 * saying "never return this", the idiomatic home of a password hash or an
 * API key.
 *
 * Such a path is left out of the entity description entirely, the same way
 * the version key is. That is deliberately stronger than hiding it from
 * responses, because the alternative leaks it two ways:
 *
 * - reads are `lean`, so Mongoose applies the projection and the value is
 *   absent from the body — but the *predicate* still runs server-side, so
 *   an allowlisted `filter[apiKey][like]=sk_live_9%` is a blind
 *   character-at-a-time extraction oracle for a value that never appears;
 * - `create` returns the hydrated document Mongoose built, and `select` is
 *   a query projection that does not apply there, so a `POST` would echo a
 *   server-generated secret that no `GET` ever returns.
 *
 * Excluding it closes both, at the cost of Kavo not managing the path at
 * all: it is not readable, writable, filterable, or sortable. An app that
 * needs to *write* one (a password on registration) does so through a
 * custom operation or the model directly — which is the safe default when
 * the schema has already declared the value un-returnable.
 */
function isHiddenField(schemaType: MongooseSchemaTypeLike): boolean {
  return schemaType.options?.select === false;
}

/**
 * The target model name of a `ref` path, or `undefined` when the path is not
 * a relation edge.
 *
 * Only a **string** `ref` counts. Mongoose also accepts a function ref and
 * the `refPath` form, where the target model is chosen per document at
 * populate time; there is no single target entity for core's relation
 * registry to point at, so such a path stays an ordinary scalar `ObjectId`
 * field rather than becoming a relation that cannot resolve.
 */
function refTargetOf(schemaType: MongooseSchemaTypeLike): string | undefined {
  const ref = schemaType.instance === "Array" ? schemaType.caster?.options?.ref : schemaType.options?.ref;
  return typeof ref === "string" ? ref : undefined;
}

/** The `createdAt`/`updatedAt` path names in effect, honouring renames. */
function timestampFields(schema: MongooseSchemaLike): ReadonlySet<string> {
  const timestamps = schema.options.timestamps;
  if (timestamps === undefined || timestamps === false) {
    return new Set();
  }
  if (timestamps === true) {
    return new Set(["createdAt", "updatedAt"]);
  }
  const names = new Set<string>();
  if (typeof timestamps.createdAt === "string") {
    names.add(timestamps.createdAt);
  } else if (timestamps.createdAt !== false) {
    names.add("createdAt");
  }
  if (typeof timestamps.updatedAt === "string") {
    names.add(timestamps.updatedAt);
  } else if (timestamps.updatedAt !== false) {
    names.add("updatedAt");
  }
  return names;
}

/** Mongoose's document-version bookkeeping path (`__v` unless renamed/disabled). */
function versionKeyOf(schema: MongooseSchemaLike): string | undefined {
  const versionKey = schema.options.versionKey;
  if (versionKey === false) {
    return undefined;
  }
  return typeof versionKey === "string" ? versionKey : "__v";
}

/**
 * Build core's `EntityMetadata` for one Mongoose model.
 *
 * Unlike `@kavo/prisma`, this adapter needs no marker class: a Mongoose
 * model *is* a constructor, so it satisfies core's `ClassRef` identity
 * directly, and `connection.models` is the name→model registry that lets a
 * `ref` resolve to its target. The one wrinkle is that a model's function
 * `name` is the useless `"model"`, so every name here comes from
 * `modelName` — `entity.name` is never read. See
 * `docs/internals/adr/0018-mongoose-models-are-entity-identities.md`.
 */
export function buildEntityMetadata<Entity extends object>(
  entity: ClassRef<Entity>,
  connection: MongooseConnectionLike,
): EntityMetadata<Entity> {
  const model = asModel(entity);
  const schema = model.schema;
  const timestamps = timestampFields(schema);
  const versionKey = versionKeyOf(schema);

  const fields: FieldMetadata[] = [];
  const relations: RelationDescriptor[] = [];
  const emitted = new Set<string>();

  // A Mongoose virtual (`schema.virtual("fullName").get(...)`, issue #373)
  // is a plain JavaScript getter Mongoose keeps in `schema.virtuals`, never
  // `schema.paths` — this loop reads `schema.paths` only, so a virtual
  // produces no `FieldMetadata` entry and carries no `derivedExpression`.
  // It is response-only at best, and naming it in a filter or sort is an
  // ordinary unknown-field 400, the documented behavior for an ORM whose
  // derived field is JS-only.
  for (const [path, schemaType] of Object.entries(schema.paths)) {
    // Mongoose's own document-version bookkeeping. It is storage detail the
    // caller never declared, so it stays out of the entity description
    // entirely — which also keeps it out of derived DTOs and, because the
    // default serializer projects onto these fields, out of every response.
    if (path === versionKey) {
      continue;
    }

    // `select: false` — the schema author already declared this value
    // un-returnable, so Kavo does not describe it at all. See
    // `isHiddenField` for why hiding it from responses alone is not enough.
    if (isHiddenField(schemaType)) {
      continue;
    }

    // Mongoose *flattens* a nested object literal — `{ address: { city:
    // String } }` becomes the paths `address.city`, `address.zip`, with no
    // `address` path of its own. Those dotted names are not keys of the
    // document core receives, so registering them verbatim would describe
    // fields that never match: the serializer's `key in source` test fails
    // and the whole nested object silently vanishes from every response,
    // while the deserializer drops it from every write. The nesting is
    // collapsed to one `json` field at the root instead — the same shape a
    // single-nested sub-schema (`instance: "Embedded"`) already produces,
    // so both spellings of "a nested object" describe identically.
    const separator = path.indexOf(".");
    if (separator !== -1) {
      const root = path.slice(0, separator);
      if (!emitted.has(root)) {
        emitted.add(root);
        fields.push({ name: root, kind: "json", nullable: true, generated: false });
      }
      continue;
    }

    const target = refTargetOf(schemaType);
    if (target !== undefined) {
      relations.push(relationDescriptor(path, schemaType, target, model.modelName, connection));
      // A `ref` path is *both* the relation edge and the foreign key: unlike
      // SQL, where `blogId` and `blog` are separate properties, Mongoose
      // stores the reference under the relation's own name. Registering it
      // as a field as well is what puts the reference id on the default
      // filter/sort/select allowlists (core derives those from `fields`
      // alone), so `?filter[author][eq]=<id>` works the way `?filter[
      // authorId][eq]=<id>` does under the other adapters.
      //
      // It does *not* put the raw id in responses: `DefaultSerializer`
      // skips any projected key that is also a relation name, emitting the
      // edge only when it is included. That asymmetry is core's to resolve,
      // not an adapter's — see doc 15 §1.
      if (!emitted.has(path)) {
        emitted.add(path);
        fields.push({
          name: path,
          kind: "string",
          nullable: schemaType.instance === "Array" ? false : schemaType.isRequired !== true,
          generated: false,
        });
      }
      continue;
    }

    const enumValues = schemaType.enumValues ?? [];
    emitted.add(path);
    fields.push({
      name: path,
      kind: fieldKindOf(schemaType),
      // An array path holds a (possibly empty) list, never null — the same
      // reading `@kavo/prisma` takes of a list field.
      nullable: schemaType.instance === "Array" ? false : schemaType.isRequired !== true,
      generated: isGeneratedField(path, schemaType, timestamps),
      ...(enumValues.length > 0 && { enumValues: [...enumValues] }),
    });
  }

  if (!fields.some((field) => field.name === ID_FIELD)) {
    throw new ConfigurationException(
      model.modelName,
      "id",
      `model '${model.modelName}' has no '${ID_FIELD}' path; Kavo requires the standard MongoDB ` +
        `primary key (an '_id: false' schema cannot be exposed as a CRUD resource)`,
    );
  }

  return {
    entity,
    name: model.modelName,
    idField: ID_FIELD,
    fields,
    relations,
    // Mongoose declares no delete-marker path the way TypeORM's
    // `@DeleteDateColumn` does, so soft delete is always explicit
    // `softDelete.field` configuration for this adapter, never
    // auto-detected — the same position `@kavo/prisma` is in.
    softDeleteField: null,
  };
}

/**
 * Narrow a `ClassRef` to a Mongoose model, or fail with an error that names
 * what was actually passed. This is the single runtime checkpoint that lets
 * `mongoose-like.ts` describe Mongoose loosely instead of having to satisfy
 * its generics structurally.
 */
export function asModel(entity: ClassRef): MongooseModelLike {
  if (!isModelLike(entity)) {
    throw new ConfigurationException(
      typeof entity === "function" ? entity.name : String(entity),
      "entity",
      "expected a Mongoose model (from mongoose.model(...) or connection.model(...)); " +
        "@kavo/mongoose uses the model itself as the entity identity, so there are no marker classes to declare",
    );
  }
  return entity;
}

function relationDescriptor(
  path: string,
  schemaType: MongooseSchemaTypeLike,
  target: string,
  ownerModelName: string,
  connection: MongooseConnectionLike,
): RelationDescriptor {
  return {
    name: path,
    // Lazy, like every other adapter's: a model registered after this one
    // still resolves, and a genuinely missing one fails only if something
    // actually asks for the edge.
    target: () => {
      const model = connection.models[target];
      if (model === undefined) {
        throw new ConfigurationException(
          ownerModelName,
          path,
          `relation '${path}' has ref '${target}', but no model named '${target}' is registered on ` +
            `the connection passed to createInfrastructure`,
        );
      }
      return model as ClassRef;
    },
    cardinality: schemaType.instance === "Array" ? "many" : "one",
    // A `ref` path always stores the ObjectId on this document, so a to-one
    // edge always owns its FK — `strategy: "key"` can read it directly.
    ...(schemaType.instance === "Array" ? {} : { ownsForeignKey: true }),
    includable: false,
    strategy: "auto",
  };
}
