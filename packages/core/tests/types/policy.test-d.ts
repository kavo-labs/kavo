import { createKavo, permission } from "@kavo/core";
import { Post } from "../support/blog-fixture.js";

/**
 * `policy` (ADR-0032, amended by ADR-0033) takes a `PolicyNode<Entity>`
 * only — the array shorthand (issue #242) is a compile-time error, not
 * just a runtime one, since `packages/core/tests/policy.spec.ts` routes
 * every `policy` call through `config as never`, which would hide this.
 */

const kavo = createKavo();

kavo.createCrud(Post, {
  // @ts-expect-error — the array shorthand was removed; use `permission(name)` or `and(...)` instead.
  operations: { updateOne: { policy: ["post:update"] } },
});

kavo.createCrud(Post, {
  // @ts-expect-error — a multi-name array is gone too; use `and(permission(a), permission(b))`.
  operations: { deleteOne: { policy: ["post:delete", "admin"] } },
});

// A `PolicyNode` still type-checks.
kavo.createCrud(Post, {
  operations: { updateOne: { policy: permission("post:update") } },
});
