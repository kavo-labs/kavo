import type { EntityMetadata } from "@kavo/core";
import { User, userMetadata } from "./user-fixture.js";

/**
 * The motivating shape for issue #261: a join-table-style entity with a
 * natural composite key and no surrogate `id` — `userId` + `topic`,
 * mirroring the `UserSentence` example the issue was filed against.
 */
export class CompositeEntity {
  userId = "";
  topic = "";
  key = "";
  owner: User | null = null;
  tags: User[] = [];
}

export const compositeMetadata: EntityMetadata<CompositeEntity> = {
  entity: CompositeEntity,
  name: "CompositeEntity",
  idField: "userId",
  compositeIdFields: ["userId", "topic"],
  fields: [
    { name: "userId", kind: "string", nullable: false, generated: false },
    { name: "topic", kind: "string", nullable: false, generated: false },
    { name: "key", kind: "string", nullable: false, generated: false },
  ],
  relations: [
    { name: "owner", target: () => User, cardinality: "one", includable: false, strategy: "auto" },
    { name: "tags", target: () => User, cardinality: "many", includable: false, strategy: "auto" },
  ],
};

/** A single-key entity whose relation targets `CompositeEntity` (issue #261's rejection case). */
export class OwnerOfComposite {
  id = 0;
  item: CompositeEntity | null = null;
}

export const ownerOfCompositeMetadata: EntityMetadata<OwnerOfComposite> = {
  entity: OwnerOfComposite,
  name: "OwnerOfComposite",
  idField: "id",
  fields: [{ name: "id", kind: "number", nullable: false, generated: true }],
  relations: [{ name: "item", target: () => CompositeEntity, cardinality: "one", includable: false, strategy: "auto" }],
};

export { userMetadata };
