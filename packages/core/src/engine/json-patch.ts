import { JsonPatchInvalidDocumentException } from "../errors/exceptions.js";

/** One RFC 6902 operation, narrowed to the subset `jsonPatch` accepts. */
export interface JsonPatchOperation {
  readonly op: "add" | "remove" | "replace";
  readonly path: string;
  readonly value?: unknown;
}

/** One relation's collected member changes, not yet id-normalized. */
export interface JsonPatchRelationOps {
  readonly add: unknown[];
  readonly remove: unknown[];
}

/**
 * A JSON Patch document's effect, split into the two things `KavoEngine`
 * feeds into different write paths: scalar field sets (fed through the
 * ordinary `patchOne` DTO deserializer, so validation is unchanged) and
 * per-relation member changes (id-normalized separately, then applied
 * through `EntityWriter.patchRelation`).
 */
export interface ParsedJsonPatch {
  /** `{ [field]: value }`, last write wins — never a relation name. */
  readonly fields: Record<string, unknown>;
  /** Keyed by write-opted-in relation name; absent relations touched no ops. */
  readonly relations: Readonly<Record<string, JsonPatchRelationOps>>;
}

export interface JsonPatchParseOptions {
  readonly entityName: string;
  /** Own, non-generated column names — the id field is never in this set. */
  readonly writableFields: ReadonlySet<string>;
  /** Relations opted into `relations.edges.<name>.write`. */
  readonly writeOptedRelations: ReadonlySet<string>;
  readonly operation: string;
  readonly correlationId: string;
}

/**
 * Parses and validates a `jsonPatch`-strategy request body (ADR-0029's
 * jsonPatch amendment) — a bare JSON array is the one shape an ordinary
 * `patchOne` object body never is, which is how `KavoEngine.resolveInput`
 * already tells the two apart before this ever runs.
 *
 * Two path shapes are legal, and nothing else — the "no arbitrary path
 * traversal" requirement is enforced structurally, not by a denylist:
 *
 * - `/<field>` (`add`/`replace` only) — a scalar, non-generated column of
 *   the entity. `remove` is rejected: there is nothing to literally delete
 *   from a partial-update payload, so a client meaning "leave this field
 *   alone" simply omits the op, the same as an ordinary `patchOne` body.
 * - `/<relation>/-` (`add`/`remove` only) — a relation opted into
 *   `relations.edges.<name>.write`. `value` names the member (a scalar id
 *   or an `{id}` reference, exactly `replace`'s own member shape) —
 *   addressing by identity rather than by array index/position, a
 *   deliberate, stated deviation from RFC 6902's array convention: to-many
 *   relation membership has no persisted order for an index to mean
 *   anything against. `replace` on this shape is rejected — that whole-array
 *   replacement is `arrayMutation.strategy: "replace"`'s own surface, kept
 *   distinct from `jsonPatch`'s incremental one.
 *
 * Member existence (`add` of an id with no matching row, `remove` of an id
 * that isn't currently a member) is *not* checked here — this function only
 * sees the document, never the database — and is instead a request-time
 * question the write path answers ({@link NotFoundException} for `add`,
 * {@link JsonPatchTargetNotFoundException} for `remove`).
 */
export function parseJsonPatchDocument(document: readonly unknown[], options: JsonPatchParseOptions): ParsedJsonPatch {
  const fields: Record<string, unknown> = {};
  const relations: Record<string, { add: unknown[]; remove: unknown[] }> = {};

  const invalid = (detail: string): never => {
    throw new JsonPatchInvalidDocumentException({
      messageParams: { entity: options.entityName, detail },
      context: { entityName: options.entityName, operation: options.operation, correlationId: options.correlationId },
    });
  };

  document.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      invalid(`op ${index} must be an object, got ${JSON.stringify(entry)}`);
    }
    const record = entry as Record<string, unknown>;
    const { op, path } = record;
    if (op !== "add" && op !== "remove" && op !== "replace") {
      invalid(`op ${index} has an unsupported 'op' ${JSON.stringify(op)} — expected "add", "remove", or "replace"`);
    }
    if (typeof path !== "string" || !path.startsWith("/") || path === "/") {
      invalid(`op ${index} has an invalid 'path' ${JSON.stringify(path)}`);
    }
    const segments = (path as string).slice(1).split("/");
    const hasValue = Object.prototype.hasOwnProperty.call(record, "value");

    if (segments.length === 1) {
      const field = segments[0]!;
      if (field === "" || !options.writableFields.has(field)) {
        invalid(`op ${index} names '${path}', which is not a writable field of '${options.entityName}'`);
      }
      if (op === "remove") {
        invalid(
          `op ${index} is 'remove' on field path '${path}' — a field cannot be removed from a partial update, ` +
            `only 'add'/'replace' are legal there`,
        );
      }
      if (!hasValue) {
        invalid(`op ${index} ('${op}' on '${path}') needs a 'value'`);
      }
      fields[field] = record.value;
      return;
    }

    if (segments.length === 2 && segments[1] === "-") {
      const relationName = segments[0]!;
      if (relationName === "" || !options.writeOptedRelations.has(relationName)) {
        invalid(
          `op ${index} names '${path}', which is not a relation of '${options.entityName}' opted into ` +
            `array-mutation writes (relations.edges.${relationName || "<name>"}.write)`,
        );
      }
      if (op === "replace") {
        invalid(
          `op ${index} is 'replace' on relation path '${path}' — 'jsonPatch' supports 'add'/'remove' member ` +
            `changes only; use 'arrayMutation.strategy: "replace"' for a whole-array replace`,
        );
      }
      if (!hasValue || record.value === null || record.value === undefined) {
        invalid(`op ${index} ('${op}' on '${path}') needs a 'value' naming the member id`);
      }
      const bucket = (relations[relationName] ??= { add: [], remove: [] });
      bucket[op as "add" | "remove"].push(record.value);
      return;
    }

    invalid(`op ${index} has path '${path}', which is neither '/<field>' nor '/<relation>/-'`);
  });

  return { fields, relations };
}
