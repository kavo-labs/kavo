import { Module, type DynamicModule } from "@nestjs/common";
import { KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/typeorm";
import type { RealtimeTransport } from "@kavo/core";
import type { DataSource } from "typeorm";
import { DATA_SOURCE, DatabaseModule, type SqlOptions } from "./database.module.js";
import { OwnerController } from "./owner/owner.controller.js";
import { CatController } from "./cat/cat.controller.js";
import { DogController } from "./dog/dog.controller.js";
import { TagController } from "./tag/tag.controller.js";
import { AddressController } from "./address/address.controller.js";

/**
 * Reference wiring: the app hands `@kavo/nest` its infrastructure (here
 * TypeORM's) — the packages never import each other (package boundary;
 * adapters meet the framework in the DI container).
 *
 * `forRoot()` defaults to the in-memory SQLite `DatabaseModule`;
 * `forRoot(sql)` threads the same options through to a real Postgres or
 * MariaDB instance instead, picked by `sql.type` (see `DatabaseModule`).
 *
 * `forRoot(sql, realtimeTransports)` additionally registers realtime
 * transports (`@kavo/sse`'s, in `main.ts`) — a root-scope option, so it
 * travels alongside `infrastructure` rather than through `defaults`
 * (ADR-0023: a transport is a live object, not settings-tree data).
 */
@Module({})
export class AppModule {
  static forRoot(sql?: SqlOptions, realtimeTransports?: readonly RealtimeTransport[]): DynamicModule {
    return {
      module: AppModule,
      imports: [
        KavoModule.forRootAsync({
          imports: [DatabaseModule.forRoot(sql)],
          inject: [DATA_SOURCE] as never[],
          // AddressController constructor-injects its own service
          // (getKavoServiceToken), which needs a real DI provider —
          // provideServices supplies one for every @Kavo entity registered so
          // far, with no separate call or list to keep in sync.
          provideServices: true,
          useFactory: (dataSource: DataSource) => ({
            infrastructure: createInfrastructure(dataSource),
            ...(realtimeTransports !== undefined && { realtimeTransports }),
            defaults: {
              pagination: { defaultLimit: 20, maxLimit: 100 },
              errors: { exposeInternals: false },
              // App-wide default (issue #38): off unless an entity opts back
              // in via its own `operations.restoreOne`. `OwnerController`
              // does exactly that.
              operations: { restoreOne: false },
            },
          }),
        }),
      ],
      controllers: [OwnerController, CatController, DogController, TagController, AddressController],
    };
  }
}
