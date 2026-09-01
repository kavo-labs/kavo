import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";

/**
 * A three-hop includable-relation chain — `Region → Zone → Landmark` — used
 * only to show issue #356's recursive `$ref` schema composition in the
 * generated OpenAPI document. None of these controllers registers an `item`
 * DTO, so every includable relation defers wholly to its target
 * (ADR-0026 decision 4) and is emitted as a `$ref` to that entity's own
 * `<Entity>Item` component. `GET
 * /regions/:id?include=zones.landmarks` therefore types transitively, and
 * `Zone.region ↔ Region.zones` is a legal `$ref` cycle.
 */
@Entity()
export class Region {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @OneToMany("Zone", (zone: Zone) => zone.region)
  zones!: Zone[];
}

@Entity()
export class Zone {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @ManyToOne("Region", (region: Region) => region.zones, { nullable: true })
  region!: Region | null;

  @OneToMany("Landmark", (landmark: Landmark) => landmark.zone)
  landmarks!: Landmark[];
}

@Entity()
export class Landmark {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @ManyToOne("Zone", (zone: Zone) => zone.landmarks, { nullable: true })
  zone!: Zone | null;
}
