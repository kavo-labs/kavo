import { Module, ValidationPipe, type DynamicModule } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/typeorm";
import type { KavoAppContext, RealtimeTransport } from "@kavo/core";
import type { DataSource } from "typeorm";
import { DATA_SOURCE, DatabaseModule, type SqlOptions } from "./database.module.js";
import { OwnerController } from "./owner/owner.controller.js";
import { CatController } from "./cat/cat.controller.js";
import { DogController } from "./dog/dog.controller.js";
import { TagController } from "./tag/tag.controller.js";
import { PhotoController } from "./photo/photo.controller.js";
import { AddressController } from "./address/address.controller.js";
import { PetTagController } from "./pet-tag/pet-tag.controller.js";
import { OwnerSettingController } from "./owner-setting/owner-setting.controller.js";
import { LandmarkController, RegionController, ZoneController } from "./nested-demo/nested-demo.controllers.js";

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
 *
 * The `APP_PIPE` below is the app's validation layer: a global
 * `class-validator`-backed `ValidationPipe`, registered here (rather than
 * `main.ts`) so it also covers the e2e test suite, which bootstraps
 * `AppModule.forRoot()` directly through `@nestjs/testing` and never runs
 * `main.ts`. `whitelist: true` strips properties a DTO class doesn't
 * declare instead of rejecting the request — generated Kavo routes already
 * silently drop unwritable keys (e.g. a client-sent `id`) the same way, so
 * this keeps that behavior rather than turning it into a 400. It only ever
 * validates a body whose declared parameter type it can resolve via
 * `emitDecoratorMetadata` — see e.g. `owner.controller.ts`'s `@Override()`'d
 * write methods for why every generated route's own body is exempt (Kavo's
 * DTOs are shapes, not validators — doc 04), and how each entity opts a
 * write route into validation.
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
            // Copies `request.user` — where `OwnerAppContextGuard`
            // (owner/owner-app-context.guard.ts) leaves it — onto
            // `context.app` (shape in src/kavo-app-context.d.ts), for
            // OwnerController's `policy.deleteOne`. Inert everywhere else,
            // since no other controller's guard populates `request.user`
            // (docs/guides/wiring-your-own-auth).
            app: (request): KavoAppContext => (request.user as KavoAppContext | undefined) ?? {},
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
      controllers: [
        OwnerController,
        CatController,
        DogController,
        TagController,
        PhotoController,
        AddressController,
        PetTagController,
        OwnerSettingController,
        RegionController,
        ZoneController,
        LandmarkController,
      ],
      providers: [
        {
          provide: APP_PIPE,
          useValue: new ValidationPipe({ whitelist: true, transform: true }),
        },
      ],
    };
  }
}
