import type { JsonSchema } from "./json-schema.js";

/**
 * The shared RFC 9457 problem-details body every 400/404/409/412 answers
 * with (`@kavo/core`'s `toProblemDetails`), and its `errors[]` entry —
 * ported verbatim from `@kavo/nest`'s `register-schemas.ts` output, so a
 * caller consuming both a `@kavo/nest` and a `@kavo/next` API sees the same
 * two component names.
 */
export const KAVO_PROBLEM_DETAIL_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    field: { type: "string" },
    code: { type: "string" },
    detail: { type: "string" },
  },
};

export const KAVO_PROBLEM_DETAILS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: {
      type: "array",
      items: { $ref: "#/components/schemas/KavoProblemDetailError" },
    },
  },
};

/** The two shared component schemas every `@kavo/next` app's OpenAPI document carries, regardless of entity. */
export function sharedKavoSchemas(): Record<string, JsonSchema> {
  return {
    KavoProblemDetails: KAVO_PROBLEM_DETAILS_SCHEMA,
    KavoProblemDetailError: KAVO_PROBLEM_DETAIL_ERROR_SCHEMA,
  };
}
