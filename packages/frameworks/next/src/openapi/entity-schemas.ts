import type { EntityMetadata, KavoEngine, RelationDescriptor, ResolvedEntityConfig } from "@kavo/core";
import { associationBodySchema, fieldSchema, filterOperatorsSchema } from "./field-schema.js";
import { paginationSlotSchema } from "./pagination-schema.js";
import type { JsonSchema } from "./json-schema.js";

/**
 * The `components.schemas` entries for one entity — the same naming
 * scheme `@kavo/nest`'s `registerKavoSchemas` produces (CLAUDE.md's
 * OpenAPI component-schema convention): `<Entity>Create`/`Update`/`Patch`/
 * `Item`/`List`, `<Entity>ListItem`/`ListMeta`, `<Entity>Pagination`/
 * `Include`/`Sort`, `<Entity>Filter`/`Query`, and `<Entity>ValidationError`.
 *
 * Unlike `@kavo/nest`, there is no decorator/reflection story here (no
 * `reflect-metadata`, no `@nestjs/swagger`) — every shape is derived from
 * `EntityMetadata` and `ResolvedEntityConfig` alone, the same ORM-independent
 * data every adapter already supplies. A configured `dto.create`/`item`/…
 * class's *actual* field shape is not introspected (there is nothing
 * portable to introspect it with outside a decorator convention); what is
 * built here is the entity's own derived shape, the same fallback
 * `@kavo/nest` itself falls back to when no DTO is registered
 * (`applyBodySchemaDocs`/`applyResponseSchemaDocs`'s undocumented-route
 * fix, issue #264).
 */
export function buildEntitySchemas(entityName: string, engine: KavoEngine<object>): Record<string, JsonSchema> {
  const metadata = engine.metadata;
  const config = engine.config;
  const fieldsByName = new Map(metadata.fields.map((field) => [field.name, field]));

  const item = itemSchema(metadata);
  const listItem = { ...item, title: `${entityName}ListItem` };
  const list = listSchema(entityName);
  const listMeta = listMetaSchema();
  const pagination = paginationSlotSchema(config.settings.pagination.strategy);
  const includable = topLevelIncludable(metadata, config);
  const include = includeSchema(includable);
  const sortable = [...config.sort.fields] as readonly string[];
  const sort = sortSchema(sortable);
  const filterableFields = [...config.filter.fields] as readonly string[];
  const filter = filterSchema(entityName, filterableFields, fieldsByName);
  const query = querySchema(entityName, includable.length > 0);
  const create = writeSchema(entityName, "Create", metadata, config, { partial: false });
  const update = writeSchema(entityName, "Update", metadata, config, { partial: false });
  const patch = writeSchema(entityName, "Patch", metadata, config, { partial: true });
  const validationError = validationErrorSchema(entityName);

  return {
    [`${entityName}Item`]: item,
    [`${entityName}ListItem`]: listItem,
    [`${entityName}List`]: list,
    [`${entityName}ListMeta`]: listMeta,
    [`${entityName}Pagination`]: pagination,
    [`${entityName}Include`]: include,
    [`${entityName}Sort`]: sort,
    [`${entityName}Filter`]: filter,
    [`${entityName}Query`]: query,
    [`${entityName}Create`]: create,
    [`${entityName}Update`]: update,
    [`${entityName}Patch`]: patch,
    [`${entityName}ValidationError`]: validationError,
  };
}

function itemSchema(metadata: EntityMetadata<object>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const field of metadata.fields) {
    properties[field.name] = fieldSchema(field);
  }
  return {
    title: `${metadata.name}Item`,
    type: "object",
    properties,
    required: metadata.fields.map((field) => field.name),
  };
}

function listSchema(entityName: string): JsonSchema {
  return {
    title: `${entityName}List`,
    type: "object",
    required: ["items", "limit", "offset", "total"],
    properties: {
      items: { type: "array", items: { $ref: `#/components/schemas/${entityName}ListItem` } },
      limit: { type: "integer" },
      offset: { type: "integer" },
      total: { type: "integer", nullable: true },
      meta: { $ref: `#/components/schemas/${entityName}ListMeta` },
    },
  };
}

/**
 * Open metadata bag about the list itself (`FindManyResult.meta`/
 * `withListMeta`) — filled by application handler code Kavo never sees, so
 * there is nothing to enumerate here. `additionalProperties: true` says
 * that explicitly; a bare `{type:"object"}` with no `properties` would
 * read to most OpenAPI generators as permitting no keys at all.
 */
function listMetaSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: true,
    description:
      "Open metadata bag about the list itself, filled by the findMany handler " +
      "(see FindManyResult.meta / withListMeta). Absent when nothing contributed; " +
      "its keys are application-defined and are not projected through a DTO.",
  };
}

function topLevelIncludable(metadata: EntityMetadata<object>, config: ResolvedEntityConfig<object>): readonly string[] {
  const relationNames = new Set(metadata.relations.map((relation: RelationDescriptor) => relation.name));
  const configured = new Set([...config.include.fields] as readonly string[]);
  return [...relationNames].filter((name) => configured.has(name));
}

function includeSchema(includable: readonly string[]): JsonSchema {
  return {
    type: "array",
    items: { type: "string", enum: [...includable] },
    description:
      "Top-level relation names embeddable via `include=` (comma-separated). " +
      "A nested path is formed by dotting into one (e.g. `owner.pets`); nested paths are not enumerated here.",
  };
}

function sortSchema(sortable: readonly string[]): JsonSchema {
  return {
    type: "array",
    items: { type: "string", enum: [...sortable, ...sortable.map((token) => `-${token}`)] },
    description:
      sortable.length === 0
        ? "No field is sortable."
        : "Sort keys, as passed to `sort=` (comma-separated). Prefix a key with `-` for descending order.",
  };
}

function filterSchema(
  entityName: string,
  filterable: readonly string[],
  fieldsByName: ReadonlyMap<
    string,
    { kind: string; nullable: boolean; generated: boolean; enumValues?: readonly string[] }
  >,
): JsonSchema {
  const filterRef: JsonSchema = { $ref: `#/components/schemas/${entityName}Filter` };
  const properties: Record<string, JsonSchema> = {};
  for (const path of filterable) {
    const field = fieldsByName.get(path);
    if (field !== undefined) {
      properties[path] = filterOperatorsSchema(field as never);
    }
  }
  return {
    type: "object",
    description:
      Object.keys(properties).length === 0
        ? "No field is filterable."
        : "Structured filter predicate mirroring `filter[field][operator]=value` and the " +
          "`filter={...}` JSON escape hatch (docs/internals/architecture/05-query-grammar.md). " +
          "Field keys are per-field operator maps; `and`/`or` take an array of nested Filter, " +
          "`not` takes one. Relation-path filters (e.g. `profile.city`) are permitted on the wire " +
          "but not enumerated as properties here.",
    properties: {
      ...properties,
      and: { type: "array", items: filterRef },
      or: { type: "array", items: filterRef },
      not: filterRef,
    },
  };
}

function querySchema(entityName: string, hasIncludable: boolean): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    filter: { $ref: `#/components/schemas/${entityName}Filter` },
    sort: { $ref: `#/components/schemas/${entityName}Sort` },
    pagination: { $ref: `#/components/schemas/${entityName}Pagination` },
    select: { type: "array", items: { type: "string" } },
  };
  if (hasIncludable) {
    properties.include = { $ref: `#/components/schemas/${entityName}Include` };
  }
  return {
    type: "object",
    description:
      "The full query surface — filter, sort, pagination, select, include — as one typed " +
      "aggregate, for a programmatic QueryContext caller (ADR-0042). No REST parameter " +
      "references this shape; REST keeps its flat query params unchanged.",
    properties,
  };
}

function writeSchema(
  entityName: string,
  slot: "Create" | "Update" | "Patch",
  metadata: EntityMetadata<object>,
  config: ResolvedEntityConfig<object>,
  options: { readonly partial: boolean },
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of metadata.fields) {
    if (field.generated) {
      continue;
    }
    if (metadata.compositeIdFields === undefined && field.name === metadata.idField) {
      continue;
    }
    properties[field.name] = fieldSchema(field);
    if (!options.partial && !field.nullable) {
      required.push(field.name);
    }
  }
  for (const relation of metadata.relations) {
    properties[relation.name] = associationBodySchema(relation.cardinality);
  }
  const writableCount = Object.keys(properties).length;
  return {
    title: `${slot}${entityName}`,
    type: "object",
    ...(writableCount === 0
      ? { description: "No field is writable for this operation." }
      : { properties, ...(required.length > 0 ? { required } : {}) }),
  };
}

function validationErrorSchema(entityName: string): JsonSchema {
  return {
    allOf: [{ $ref: "#/components/schemas/KavoProblemDetails" }],
    description:
      `Request validation failed for the ${entityName} entity (RFC 9457 problem details). ` +
      "Each `errors[]` entry identifies the offending field.",
  };
}
