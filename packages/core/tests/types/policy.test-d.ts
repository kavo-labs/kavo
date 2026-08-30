import { createKavo } from "@kavo/core";
import type { Policy } from "@kavo/core";
import { Post } from "../support/blog-fixture.js";

/**
 * `policy` (ADR-0037) takes a `Policy<Entity>` function at every scope —
 * `operations.<id>.policy`, `EntityConfig.policy`, `createKavo({ policy })`
 * — an array or any other non-function shape is a compile-time error, not
 * just a runtime one, since `packages/core/tests/policy.spec.ts` routes
 * every `policy` call through `config as never`, which would hide this.
 */

const kavo = createKavo();

kavo.createCrud(Post, {
  // @ts-expect-error — 'policy' takes a function, not an array of permission names.
  operations: { updateOne: { policy: ["post:update"] } },
});

kavo.createCrud(Post, {
  // @ts-expect-error — 'policy' takes a function, not a bare string.
  operations: { deleteOne: { policy: "post:delete" } },
});

kavo.createCrud(Post, {
  // @ts-expect-error — entity-level 'policy' takes a function too, not the pre-ADR-0033 per-operation map.
  policy: { updateOne: () => false },
});

// A plain function still type-checks, at every scope.
const hasPermission: Policy<Post> = ({ context }) =>
  ((context.app as { permissions?: readonly string[] }).permissions ?? []).includes("post:update");

kavo.createCrud(Post, {
  operations: { updateOne: { policy: hasPermission } },
});

kavo.createCrud(Post, {
  policy: hasPermission,
});

// 'false' opts an operation out of an inherited entity/global default.
kavo.createCrud(Post, {
  policy: hasPermission,
  operations: { findMany: { policy: false } },
});

// GlobalConfig.policy is untyped to any entity (Policy<unknown>) — a
// concrete Policy<Post> is a narrower function type and not assignable to
// it (contravariant parameter), so the global default is written generic.
const globalHasPermission: Policy = ({ context }) =>
  ((context.app as { permissions?: readonly string[] }).permissions ?? []).includes("post:update");

createKavo({ policy: globalHasPermission });
