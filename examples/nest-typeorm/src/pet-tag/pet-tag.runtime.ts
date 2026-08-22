import { QueryValidationException } from "@kavo/core";

/** Reused by `PetTagController`'s `createOne`/`updateOne`/`patchOne` overrides. */
export function normalizeNote(raw: string): string {
  return raw.trim();
}

export function assertValidNote(value: string): void {
  if (value.length === 0) {
    throw QueryValidationException.single({
      field: "note",
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: "note must not be empty",
    });
  }
}
