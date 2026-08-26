import { QueryValidationException } from "@kavo/core";

/**
 * MongoDB resolves a dotted path *within a document*, never across a `ref`
 * edge. `{ "address.city": "Paris" }` is a first-class query because
 * `address` is an embedded subdocument; `{ "author.name": "Ada" }` is not a
 * join — `author` holds an `ObjectId`, so the path simply matches nothing.
 *
 * That distinction is the whole reason this guard exists. `@kavo/typeorm`
 * turns a relation-path condition into a `JOIN` and `@kavo/prisma` nests it
 * into Prisma's native `where`; MongoDB can only do it through an
 * aggregation `$lookup`, which is out of scope for this adapter. Silently
 * translating `author.name` would therefore return an empty result set
 * instead of an error — a dropped predicate, which is exactly the failure
 * mode adapters must never have.
 *
 * So: a dotted path rooted at an **embedded field** passes through
 * untouched (MongoDB handles it natively, and it costs nothing to support),
 * and a dotted path rooted at a **relation** is refused.
 *
 * Reaching this is always the result of explicitly allowlisting a relation
 * path — core's default `filterable`/`sortable` allowlists contain scalar
 * fields only — so it is a configuration mistake surfacing at query time,
 * not something an ordinary client request can trigger.
 */
export function assertQueryablePath(
  field: string,
  relationNames: ReadonlySet<string>,
  usage: "filtering" | "sorting",
): void {
  const separator = field.indexOf(".");
  if (separator === -1) {
    return;
  }
  const root = field.slice(0, separator);
  if (!relationNames.has(root)) {
    return;
  }

  throw QueryValidationException.single({
    field,
    code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    detail:
      `Query parameter '${field}' is not supported: @kavo/mongoose cannot use the relation ` +
      `'${root}' for ${usage}, because MongoDB resolves dotted paths inside a document rather ` +
      `than across a 'ref'. Filter or sort on a field of '${root}' by querying that collection ` +
      `directly, or remove '${field}' from the allowlist.`,
  });
}
