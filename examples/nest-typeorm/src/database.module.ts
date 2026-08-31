import { Global, Module, type DynamicModule } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Owner } from "./owner/owner.entity.js";
import { Pet } from "./pet/pet.entity.js";
import { Cat } from "./cat/cat.entity.js";
import { Dog } from "./dog/dog.entity.js";
import { Tag } from "./tag/tag.entity.js";
import { Photo } from "./photo/photo.entity.js";
import { Address } from "./address/address.entity.js";
import { PetTag } from "./pet-tag/pet-tag.entity.js";
import { OwnerSetting } from "./owner-setting/owner-setting.entity.js";
import { Landmark, Region, Zone } from "./nested-demo/nested-demo.entities.js";

export const DATA_SOURCE = Symbol("DATA_SOURCE");

const entities = [Owner, Pet, Cat, Dog, Tag, Photo, Address, PetTag, OwnerSetting, Region, Zone, Landmark];

interface ConnectionOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface PostgresOptions extends ConnectionOptions {
  type: "postgres";
}

export interface MariaDbOptions extends ConnectionOptions {
  type: "mariadb";
}

/**
 * CockroachDB's default `--insecure` mode (used locally and in the e2e
 * container) has no password, so unlike the other two drivers it is
 * optional here.
 */
export interface CockroachDbOptions extends Omit<ConnectionOptions, "password"> {
  type: "cockroachdb";
  password?: string;
}

/** The driver a real (non-SQLite) `forRoot(...)` call picks. */
export type SqlOptions = PostgresOptions | MariaDbOptions | CockroachDbOptions;

/**
 * One `DataSource` for the whole app. `forRoot()` (no argument) defaults to
 * an in-memory SQLite database, keeping the demo (and its e2e suite)
 * dependency-free; `forRoot(sql)` switches the same app to a real Postgres,
 * MariaDB, or CockroachDB instance instead, picked by `sql.type` — see
 * `examples/nest-typeorm/README.md` for the `docker run` used locally for
 * each, and `tests/app-postgres.e2e.spec.ts` / `tests/app-mariadb.e2e.spec.ts`
 * / `tests/app-cockroach.e2e.spec.ts` for how the e2e suite self-provisions
 * one via Testcontainers.
 *
 * Global so `DATA_SOURCE` is injectable straight into any `@Kavo`
 * controller (e.g. `AddressController`'s `@Override`'d methods), not just
 * where `DatabaseModule` is nested (`KavoModule.forRootAsync`'s own
 * `imports`).
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(sql?: SqlOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DATA_SOURCE,
          useFactory: async (): Promise<DataSource> => {
            const dataSource = sql
              ? new DataSource(
                  sql.type === "cockroachdb"
                    ? { ...sql, entities, synchronize: true, timeTravelQueries: false }
                    : { ...sql, entities, synchronize: true },
                )
              : new DataSource({
                  type: "better-sqlite3",
                  database: ":memory:",
                  entities,
                  synchronize: true,
                });
            return dataSource.initialize();
          },
        },
      ],
      exports: [DATA_SOURCE],
    };
  }
}
