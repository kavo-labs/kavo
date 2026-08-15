import {
  Column,
  CreateDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  PrimaryGeneratedColumn,
  TableInheritance,
} from "typeorm";
// Type-only import + string relation target keep the Owner↔Pet cycle off the
// runtime graph (TypeORM resolves "Owner" by entity name at metadata build).
import type { Owner } from "../owner/owner.entity.js";
// Tag carries no reference back to Pet, so there is no cycle to keep off the
// runtime graph here — a plain, real import is fine.
import { Tag } from "../tag/tag.entity.js";
import { Photo } from "../photo/photo.entity.js";

/**
 * The single-table inheritance base. `Pet` is never served directly — you
 * cannot create a bare Pet, only a concrete Cat or Dog — so the class is
 * `abstract`. The discriminator column (`species`) has no entity property:
 * it is written automatically by the child repository on insert.
 *
 * The `owner` relation is opened for inclusion on the Cat route
 * (`include=owner`) — inclusion is opt-in per relation, so a relation the
 * config never names stays invisible.
 */
/** Enum column shared by every Pet subtype. */
export enum PetSizeEnum {
  Small = "small",
  Medium = "medium",
  Large = "large",
}

@Entity()
@TableInheritance({ column: { type: "varchar", name: "species" } })
export abstract class Pet {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @Column("int")
  age!: number;

  // An enum column: the adapter surfaces it as the `enum` FieldKind with its
  // allowed values, so filters coerce against the set.
  @Column({ type: "simple-enum", enum: PetSizeEnum, default: PetSizeEnum.Medium })
  size!: PetSizeEnum;

  @ManyToOne("Owner", (owner: Owner) => owner.pets, { nullable: true })
  owner!: Owner | null;

  // Owning side of the many-to-many edge: `include=tags` batch-loads through
  // the join table `@JoinTable()` creates. Unidirectional — `Tag`
  // has no inverse `pets` field, since nothing browses pets from a tag.
  @ManyToMany(() => Tag)
  @JoinTable()
  tags!: Tag[];

  // A second to-many edge, unidirectional like `tags` — opted into the
  // `resource` array-mutation strategy on `Cat` rather than `replace`
  // (ADR-0029's per-relation amendment, issue #223), so the two relations
  // demonstrate two different strategies on the same entity.
  @ManyToMany(() => Photo)
  @JoinTable()
  photos!: Photo[];

  @CreateDateColumn()
  createdAt!: Date;
}
