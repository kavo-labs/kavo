import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { Pet } from "../pet/pet.entity.js";
import { Tag } from "../tag/tag.entity.js";

/**
 * A composite-key join entity (ADR-0039, issue #267): `petId`/`tagId` are
 * the whole primary key, declared in this order, and there is no surrogate
 * `id` column at all. Mirrors the `UserSentence` shape from
 * `docs/features/composite-primary-keys.md` — each key column doubles as a
 * `@JoinColumn` for a plain `@ManyToOne` association-by-id relation, kept
 * deliberately unidirectional (neither `Pet` nor `Tag` references it back),
 * the same choice `Tag`'s own relation to `Pet` already makes.
 *
 * Both relations stay plain `@ManyToOne`s rather than a `@ManyToMany` —
 * ADR-0039 refuses many-to-many array-mutation writes on a composite-keyed
 * entity at `createCrud` bootstrap, since TypeORM's `RelationQueryBuilder`
 * can't address a 2+ column owning side. `Pet.tags` already exercises the
 * `@ManyToMany` shape; this entity exercises the composite-key one instead.
 */
@Entity()
export class PetTag {
  @PrimaryColumn()
  petId!: number;

  @ManyToOne(() => Pet)
  @JoinColumn({ name: "petId" })
  pet!: Pet;

  @PrimaryColumn()
  tagId!: number;

  @ManyToOne(() => Tag)
  @JoinColumn({ name: "tagId" })
  tag!: Tag;

  @Column("varchar")
  note!: string;
}
