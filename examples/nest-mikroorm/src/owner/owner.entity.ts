import { Collection } from "@mikro-orm/core";
import { Entity, OneToMany, OneToOne, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
// Type-only imports + string relation targets keep the Owner↔Pet and
// Owner↔Address cycles off the runtime graph — see `pet.entity.ts`.
import type { Address } from "../address/address.entity.js";
import type { Pet } from "../pet/pet.entity.js";

/**
 * The relation side of the example: an Owner has many Pets.
 *
 * Owners are soft-deletable, but — unlike the TypeORM example's `Owner`,
 * which only needs `@DeleteDateColumn` — nothing in a MikroORM entity can
 * declare a delete marker. `deletedAt` is an ordinary nullable property and
 * `OwnerController` names it through `delete.field`; that config is the
 * only thing that turns it into the marker (doc 17 §5).
 *
 * Caveat worth seeing in a reference app: a soft-deleted owner still
 * occupies the unique `email` index, so re-creating one after deleting it
 * is a 409 until the index is made partial
 * (`… ON owner (email) WHERE deleted_at IS NULL`).
 */
@Entity()
export class Owner {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  name!: string;

  @Property({ type: "string", unique: true })
  email!: string;

  /** A nullable, client-writable date column — unlike the generated `createdAt`. */
  @Property({ type: "Date", nullable: true })
  startedAt: Date | null = null;

  @OneToMany((): any => "Pet", "owner")
  pets = new Collection<Pet>(this);

  // The owning side of the one-to-one: Owner carries the nullable join
  // column. `owner: true` is what makes this the owning side, the MikroORM
  // counterpart of TypeORM's explicit `@JoinColumn`.
  @OneToOne((): any => "Address", undefined, { owner: true, nullable: true })
  address: Address | null = null;

  @Property({ type: "Date", onCreate: () => new Date() })
  createdAt!: Date;

  /** The soft-delete marker, named by `OwnerController`'s `delete.field`. */
  @Property({ type: "Date", nullable: true })
  deletedAt: Date | null = null;
}
