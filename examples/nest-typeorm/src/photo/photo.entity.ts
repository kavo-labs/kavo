import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

/**
 * A shared image, associated with pets the same way `Tag` is: unidirectional
 * — `Photo` carries no back-reference to `Pet` — with the owning
 * `@ManyToMany` living on `Pet` (`photos`). Demonstrates a second write-opted
 * relation on `Cat` using a strategy different from `tags`'s (the `resource`
 * strategy, ADR-0029's resource amendment; the per-relation strategy choice
 * is issue #223, now the only form since issue #404): `tags` picks `replace`
 * (a single whole-array `PUT`), `photos` picks the four-operation
 * sub-collection surface instead.
 */
@Entity()
export class Photo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  url!: string;
}
