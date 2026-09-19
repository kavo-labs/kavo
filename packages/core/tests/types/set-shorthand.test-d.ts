import { createKavo } from "@kavo/core";
import type { SetConfig, WriteApply } from "@kavo/core";
import { Post } from "../support/blog-fixture.js";

/**
 * `EntityConfig.set` (issue #476, supersedes the issue #391 `create.apply`/
 * `update.apply`): a bare function forces the same values on both
 * `createOne` and `updateOne`; a `{ create?, update? }` object lets the two
 * diverge. Both forms return `Partial<EntityInput<Entity>> | undefined`,
 * the same shape `WriteApply` already had.
 */

const kavo = createKavo();

const bare: WriteApply<Post> = () => ({ authorId: 1 });
const perOperation: SetConfig<Post> = {
  create: () => ({ authorId: 1 }),
  update: () => ({ authorId: 2 }),
};

kavo.createCrud(Post, { set: bare });
kavo.createCrud(Post, { set: perOperation });
kavo.createCrud(Post, { set: { create: () => ({ authorId: 1 }) } });
kavo.createCrud(Post, { set: { update: () => ({ authorId: 2 }) } });

kavo.createCrud(Post, {
  // @ts-expect-error — 'set' takes a function or a { create?, update? } object, not a plain filter shape.
  set: { userId: "u-1" },
});

kavo.createCrud(Post, {
  set: {
    // @ts-expect-error — 'set.create' returns a `Partial<EntityInput<Post>>`, not a boolean.
    create: () => true,
  },
});
