import type { ClassRef, EntityMetadata, FieldKind, FieldMetadata, RelationDescriptor } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import type { PrismaDatamodel, PrismaField } from "./datamodel.js";

/**
 * Prisma scalar type name → core's ORM-independent `FieldKind`. Unrecognized
 * scalar names (a future Prisma type this mapping hasn't caught up to)
 * degrade to `string`, same posture as `@kavo/typeorm`'s fallback.
 */
function fieldKindOf(field: PrismaField): FieldKind {
  if (field.kind === "enum") {
    return "enum";
  }
  switch (field.type) {
    case "Int":
    case "Float":
    case "BigInt":
    case "Decimal":
      return "number";
    case "Boolean":
      return "boolean";
    case "DateTime":
      return "date";
    case "Json":
      return "json";
    default:
      return "string";
  }
}

/**
 * A column is "generated" (excluded from `create`/`update`/`patch` DTO
 * defaults, per `EntityMetadata.fields[].generated`) when Prisma or the
 * database computes its value at write time rather than the caller
 * supplying one: `@updatedAt`, or a function-style `@default(...)`
 * (`autoincrement()`, `now()`, `cuid()`, `uuid()`, `dbgenerated(...)`).
 * A literal default (`@default("active")`, `@default(0)`) is an ordinary
 * writable column with a fallback value, not a generated one — matching
 * `@kavo/typeorm`, where `@Column({ default: "active" })` isn't `generated`
 * either.
 */
function isGeneratedField(field: PrismaField): boolean {
  if (field.isUpdatedAt) {
    return true;
  }
  if (!field.hasDefaultValue) {
    return false;
  }
  const value = field.default;
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build core's `EntityMetadata` for one entity from Prisma's DMMF.
 *
 * Prisma models have no runtime class the way TypeORM's `@Entity()`
 * classes do, so `entity` is a *marker class* the caller declares purely as
 * the `ClassRef` identity `createCrud` requires — matched to a DMMF model
 * by name (`class Author {}` ↔ `model Author { … }`). `entities` is the
 * name→class registry that lets a relation's target model name resolve
 * back to *its* marker class; TypeORM gets this for free from
 * `DataSource#entities`, Prisma has no equivalent, so
 * `createInfrastructure` collects it explicitly (see
 * `docs/internals/adr/0017-prisma-marker-classes-and-entity-registry.md`).
 */
export function buildEntityMetadata<Entity extends object>(
  datamodel: PrismaDatamodel,
  entity: ClassRef<Entity>,
  entities: ReadonlyMap<string, ClassRef>,
): EntityMetadata<Entity> {
  const modelName = entity.name;
  const model = datamodel.models.find((candidate) => candidate.name === modelName);
  if (model === undefined) {
    throw new ConfigurationException(
      modelName,
      "entity",
      `No Prisma model named '${modelName}' in the supplied datamodel — the marker class name must match ` +
        `the schema's model name exactly`,
    );
  }

  const idFields = model.fields.filter((field) => field.isId);
  if (idFields.length !== 1) {
    throw new ConfigurationException(
      modelName,
      "id",
      `Kavo requires exactly one @id field; found ${idFields.length} on model '${modelName}' ` +
        `(composite primary keys are out of scope)`,
    );
  }

  const fields: FieldMetadata[] = model.fields
    .filter((field) => field.kind !== "object")
    .map((field) => ({
      name: field.name,
      kind: fieldKindOf(field),
      nullable: field.isList ? false : !field.isRequired,
      generated: isGeneratedField(field),
      ...(field.kind === "enum" && {
        enumValues: (datamodel.enums.find((candidate) => candidate.name === field.type)?.values ?? []).map(
          (value) => value.name,
        ),
      }),
    }));

  const relations: RelationDescriptor[] = model.fields
    .filter((field): field is PrismaField & { kind: "object" } => field.kind === "object")
    .map((field) => relationDescriptor(field, modelName, entities));

  return {
    entity,
    name: model.name,
    idField: idFields[0]!.name,
    fields,
    relations,
    // Prisma declares no delete-marker column the way TypeORM's
    // `@DeleteDateColumn` does — soft delete is always explicit
    // `softDelete.field` configuration for this adapter, never
    // auto-detected.
    softDeleteField: null,
  };
}

/**
 * One relation edge, as the filter translator needs to see it: which
 * Prisma model it lands on, and whether it is a list.
 */
export interface PrismaRelationEdge {
  readonly cardinality: "one" | "many";
  /** Target model name — the key to look up for the next path segment. */
  readonly target: string;
}

/**
 * Model name → relation property name → edge, for the whole datamodel.
 *
 * `EntityMetadata.relations` describes one entity, which is enough for
 * include resolution but not for a filter path: `author.posts.title` walks
 * two models, and only the second hop knows whether `posts` is a list. The
 * graph is derived once at bootstrap (`createInfrastructure`) and handed to
 * the translator as plain data, which is what keeps `translateFilter` a
 * pure function rather than something that reaches for a client.
 */
export type PrismaRelationGraph = ReadonlyMap<string, ReadonlyMap<string, PrismaRelationEdge>>;

/** Derive {@link PrismaRelationGraph} from Prisma's DMMF. */
export function buildRelationGraph(datamodel: PrismaDatamodel): PrismaRelationGraph {
  return new Map(
    datamodel.models.map((model) => [
      model.name,
      new Map(
        model.fields
          .filter((field) => field.kind === "object")
          .map((field): [string, PrismaRelationEdge] => [
            field.name,
            { cardinality: field.isList ? "many" : "one", target: field.type },
          ]),
      ),
    ]),
  );
}

function relationDescriptor(
  field: PrismaField,
  ownerModelName: string,
  entities: ReadonlyMap<string, ClassRef>,
): RelationDescriptor {
  return {
    name: field.name,
    target: () => {
      const target = entities.get(field.type);
      if (target === undefined) {
        throw new ConfigurationException(
          ownerModelName,
          field.name,
          `Relation '${field.name}' targets Prisma model '${field.type}', but no marker class for it was ` +
            `registered with createInfrastructure's 'entities' list`,
        );
      }
      return target;
    },
    cardinality: field.isList ? "many" : "one",
    includable: false,
    strategy: "auto",
  };
}
