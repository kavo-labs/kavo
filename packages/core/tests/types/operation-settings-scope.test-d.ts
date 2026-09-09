import { createKavo } from "@kavo/core";
import type { KavoContext } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Per-operation settings scope (issue #415): `operations.<id>` accepts only
 * the `KavoSettings` keys that id's engine stages actually read — the same
 * per-id narrowing issue #131 gave the `dto` slot. A key an id ignores is
 * pinned to `never`, so naming it is a compile error rather than a value
 * that resolves into `settingsFor(op)` and is then silently dropped.
 *
 *   pagination → findMany
 *   realtime   → createOne, updateOne, patchOne, deleteOne, restoreOne, purgeOne
 *   delete     → findOne, findMany, deleteOne, restoreOne, purgeOne
 *   cache      → every operation (its `etag` half gates If-Match/304 on the
 *                writes and void deletes too, not just the reads it caches)
 *   errors     → every operation
 *   identifier → no operation (ADR-0052) — global/entity scope only, never
 *                per-operation or per-call; naming it under any `operations.<id>`
 *                is a compile error for every id, standard or custom.
 *
 * For a custom operation the accepted subset follows from the `kind` and
 * `cardinality` literals the entry declares: `errors`/`cache` always,
 * `delete` on any `kind: "read"`, `pagination` also on `kind: "read",
 * cardinality: "many"`, `realtime` on `kind: "write", cardinality: "one"`
 * (issue #175 — the entry also has to declare `realtimeEvent` for it to do
 * anything, but the settings key is in scope either way), never otherwise.
 *
 * Collected by `*.spec.ts` only, so nothing here runs — `tsc` checks the
 * `@ts-expect-error` directives, and an unused one is itself an error.
 */

const kavo = createKavo();

// ── Standard operations — accepted ───────────────────────────────────

void kavo.createCrud(Author, { operations: { findMany: { pagination: { defaultLimit: 20, maxLimit: 100 } } } });
void kavo.createCrud(Author, { operations: { findMany: { cache: { ttl: 60 } } } });
void kavo.createCrud(Author, { operations: { findMany: { delete: false } } });
void kavo.createCrud(Author, { operations: { findOne: { cache: { ttl: 60 } } } });
void kavo.createCrud(Author, { operations: { findOne: { delete: { strategy: "hard" } } } });
void kavo.createCrud(Author, { operations: { createOne: { realtime: false } } });
void kavo.createCrud(Author, { operations: { updateOne: { realtime: false } } });
void kavo.createCrud(Author, { operations: { patchOne: { realtime: false } } });
void kavo.createCrud(Author, { operations: { restoreOne: { realtime: false } } });
void kavo.createCrud(Author, { operations: { purgeOne: { realtime: false } } });
void kavo.createCrud(Author, { operations: { purgeOne: { delete: false } } });
// `cache.etag` at operation scope on a write is a shipped feature —
// `caching.e2e.spec.ts` "reads cache.etag at the operation scope" depends on it.
void kavo.createCrud(Author, { operations: { updateOne: { cache: { etag: false } } } });
void kavo.createCrud(Author, { operations: { deleteOne: { cache: { etag: false } } } });
// `deleteOne: { delete: { strategy } }` is a shipped feature —
// `soft-delete.spec.ts` "applies a per-operation strategy override".
void kavo.createCrud(Author, { operations: { deleteOne: { delete: { strategy: "hard" } } } });
// `errors` is in scope for every id.
void kavo.createCrud(Author, { operations: { createOne: { errors: { exposeInternals: true } } } });
void kavo.createCrud(Author, { operations: { findMany: { errors: { exposeInternals: true } } } });

// ── Standard operations — rejected ───────────────────────────────────

void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — createOne consults no soft-delete strategy (issue #415's motivating case).
    createOne: { delete: false },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a single-row findOne has no pagination window (issue #415's motivating case).
    findOne: { pagination: { defaultLimit: 20, maxLimit: 100 } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — only findMany paginates.
    createOne: { pagination: { defaultLimit: 20 } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — updateOne mutates by id and consults no soft-delete strategy.
    updateOne: { delete: { strategy: "hard" } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — patchOne does not paginate.
    patchOne: { pagination: { defaultLimit: 20 } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a read emits no realtime event.
    findOne: { realtime: false },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a read emits no realtime event.
    findMany: { realtime: false },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — identifier (ADR-0052) is global/entity scope only, never per-operation.
    findOne: { identifier: { field: "slug" } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — identifier is out of scope for a write operation too.
    updateOne: { identifier: { field: "slug" } },
  },
});

// ── Custom operations — accepted ─────────────────────────────────────

const handler = { async execute(_input: unknown, _context: KavoContext<Author>) {} };

void kavo.createCrud(Author, {
  operations: {
    listArchivedMany: { handler, kind: "read", cardinality: "many", pagination: { defaultLimit: 20, maxLimit: 100 } },
  },
});
void kavo.createCrud(Author, {
  operations: { peekArchivedOne: { handler, kind: "read", delete: false } },
});
void kavo.createCrud(Author, {
  operations: { listArchivedMany: { handler, kind: "read", cardinality: "many", delete: false } },
});
void kavo.createCrud(Author, {
  operations: { peekOne: { handler, kind: "read", cache: { ttl: 60 } } },
});
// Implicit write/one — `errors`/`cache` are still in scope.
void kavo.createCrud(Author, {
  operations: { markPaidOne: { handler, errors: { exposeInternals: true }, cache: { etag: false } } },
});
// A `kind: "write"`, `cardinality: "one"` custom operation is a realtime event source (issue #175).
void kavo.createCrud(Author, {
  operations: { markPaidOne: { handler, realtime: false, realtimeEvent: "updated" } },
});
void kavo.createCrud(Author, {
  operations: { markPaidOne: { handler, kind: "write", realtime: false, realtimeEvent: "updated" } },
});

// ── Custom operations — rejected ─────────────────────────────────────

void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a read that returns one row has no pagination window.
    peekArchivedOne: { handler, kind: "read", pagination: { defaultLimit: 20 } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — implicit write/one: pagination is not in scope.
    markPaidOne: { handler, pagination: { defaultLimit: 20 } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — cardinality "many" without kind "read" is still a write; no pagination.
    markPaidMany: { handler, cardinality: "many", pagination: { defaultLimit: 20 } },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a read emits no realtime event, custom ids included.
    peekArchivedOne: { handler, kind: "read", realtime: false },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a "many" write has no single row for a RealtimeEventDto to describe.
    markPaidMany: { handler, cardinality: "many", realtime: false },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a custom write drives its own writes; a resolved soft-delete view changes nothing.
    markPaidOne: { handler, delete: false },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — explicit kind: "write" is still no soft-delete scope.
    markPaidOne: { handler, kind: "write", delete: false },
  },
});
void kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — identifier (ADR-0052) is never in scope for a custom operation either.
    markPaidOne: { handler, identifier: { field: "slug" } },
  },
});
