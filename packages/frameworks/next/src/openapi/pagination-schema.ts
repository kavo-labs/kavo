import type { JsonSchema } from "./json-schema.js";

const LIMIT_DESCRIPTION = "Maximum rows to return.";
const UNPAGINATED_DESCRIPTION = "Pagination is disabled for this entity; every row is returned in one page.";

/**
 * The `<Entity>Pagination` shape for one resolved `pagination.strategy` —
 * ported from `@kavo/nest`'s `swagger.ts` `paginationSlotSchema` (issue
 * #319): the literal wire keys the matching `PaginationStrategy.normalize`
 * reads (`packages/core/src/query/pagination-strategies.ts`).
 */
export function paginationSlotSchema(strategy: string): JsonSchema {
  const integer = (description: string): JsonSchema => ({ type: "integer", description });

  switch (strategy) {
    case "none":
      return {
        type: "object",
        properties: { limit: { type: "integer" }, offset: { type: "integer" } },
        description: UNPAGINATED_DESCRIPTION,
      };
    case "page":
      return {
        type: "object",
        properties: {
          "page[number]": integer("1-based page number."),
          "page[size]": integer(LIMIT_DESCRIPTION),
        },
      };
    case "cursor":
      return {
        type: "object",
        properties: {
          limit: integer(LIMIT_DESCRIPTION),
          cursor: {
            type: "string",
            description: "Opaque page token — pass back `meta.nextCursor` from the previous page verbatim.",
          },
        },
      };
    case "since":
      return {
        type: "object",
        properties: {
          limit: integer(LIMIT_DESCRIPTION),
          since: {
            type: "string",
            description: "Seek boundary — pass back `meta.nextSince` from the previous poll verbatim.",
          },
        },
      };
    default:
      return {
        type: "object",
        properties: {
          limit: integer(LIMIT_DESCRIPTION),
          offset: integer("Zero-based index of the first returned row."),
        },
      };
  }
}
