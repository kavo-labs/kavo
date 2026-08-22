import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";
import { Owner } from "../owner/owner.entity.js";

/**
 * A shared-primary-key one-to-one (issue #267): `owner_id` is this entity's
 * sole `@PrimaryColumn` *and* the `@JoinColumn` of its `@OneToOne` to
 * `Owner` — there is no separate `id` column. A different shape from the
 * app's other one-to-one (`Owner`↔`Address`, where `Address` has its own
 * generated `id`): here the child's identity *is* the parent's id, so a
 * given `Owner` can have at most one `OwnerSetting` row, addressed by the
 * same id the owner itself uses. Single-column, not composite — no
 * `compositeIdFields` involved (ADR-0039), just a natural key that happens
 * to also be a foreign key.
 */
@Entity()
export class OwnerSetting {
  @PrimaryColumn()
  owner_id!: number;

  @OneToOne(() => Owner)
  @JoinColumn({ name: "owner_id" })
  owner!: Owner;

  @Column("varchar")
  theme!: string;

  @Column("boolean", { default: true })
  emailNotifications!: boolean;
}
