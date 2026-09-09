import { Controller, Inject, UseGuards } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, RequestPreconditions } from "@kavo/core";
import { Owner } from "./owner.entity.js";
import { CreateOwnerDto, UpdateOwnerDto, PatchOwnerDto, OwnerItemDto, OwnerListDto } from "./owner.dtos.js";
import { OwnerAppContextGuard } from "./owner-app-context.guard.js";
import { hasPermission } from "./owner.policy.js";
import { OwnerWelcomeService } from "./owner-welcome.service.js";

/**
 * CRUD over the relation side. The unique `email` column is what surfaces a
 * database unique-violation as an RFC 9457 409 conflict.
 *
 * Relations: `GET /owners?include=pets` embeds each owner's
 * pets, projected through the Pet entity's own shape.
 *
 * Soft delete: declaring `strategy: "soft"` is what puts
 * `PATCH /owners/:id/restore` on the router — route generation runs before
 * any ORM metadata exists, so the config, not the entity, is what it can
 * read (ADR-0013). `purgeOne` is off by default everywhere; asked for by
 * name it adds `DELETE /owners/:id/purge`. Naming `restoreOne` below is
 * required regardless of the soft-delete auto-enable, because `operations`
 * is an exclusive whitelist here (issue #257) — and it also opts back in
 * from `AppModule`'s global `defaults.operations.restoreOne: false`
 * (issue #38), since entity config always wins over the global default.
 *
 * Realtime: every standard write publishes to whatever transports
 * `AppModule.forRoot`'s second argument registers — `main.ts` wires
 * `@kavo/sse`, so `GET /realtime?channel=Owner.<id>` or
 * `?channel=Owner` (every owner, issue #160's collection channel) streams
 * these events over `text/event-stream`.
 *
 * Search: `GET /owners?search[query]=ada` free-text searches every own
 * string column — `name` and `email` — since `allowed.searchable` is
 * left unconfigured here (contrast Cat's explicit array): the zero-config
 * default. `search[fields]=name` narrows a given request to just one.
 *
 * Validation: `createOne`/`updateOne`/`patchOne` are `@Override()`'d to give
 * their body parameter a concrete, `class-validator`-decorated type
 * (`CreateOwnerDto`/`UpdateOwnerDto`/`PatchOwnerDto`) — Kavo's own DTOs are
 * shapes only (doc 04); teams wire NestJS's own `ValidationPipe`
 * (`app.module.ts`) for actual validation. As of issue #281, a registered
 * `dto.create`/`update`/`patch` class validates on a *generated* route too
 * (`@Kavo` writes the `design:paramtypes` metadata `ValidationPipe` needs),
 * so these overrides are no longer required for validation to run; each
 * override still exists here purely to give the body a concrete compile-time
 * type inside the method body, and otherwise just delegates.
 *
 * Authorization: `DELETE /owners/:id` additionally requires the
 * `owner:delete` permission (ADR-0037) — `hasPermission('owner:delete')`
 * (`owner.policy.ts`), a one-line `Policy<Owner>`. `OwnerAppContextGuard`
 * stands in for a real app's auth layer, reading a comma-separated
 * `x-permissions` header into the shape `hasPermission` reads off
 * `context.app`; `AppModule`'s `app` extractor is what moves it from
 * `request.user` onto `context.app`. No other route on this
 * controller, and no other controller in this app, is gated — see
 * `docs/guides/wiring-your-own-auth` for more on writing a policy function.
 *
 * Custom operation without a config-level `handler`: `POST /owners/:id/welcome`
 * (`welcomeOne`, issue #424) declares no `handler` at all — its `operations`
 * entry below is route metadata only. `@Override("welcomeOne")` is the whole
 * implementation, and it needs to be: welcoming an owner means calling the
 * injected `OwnerWelcomeService`, which a config-level handler (a plain
 * object with no `this` and no constructor) could never reach. Omitting both
 * a `handler` and a matching `@Override` is a `ConfigurationException` at
 * `KavoModule`'s bind time, not a silent no-op route — see
 * `docs/guides/configuration/operations#custom-operations`.
 */
@Kavo(Owner, {
  dto: {
    create: CreateOwnerDto,
    update: UpdateOwnerDto,
    item: OwnerItemDto,
    list: OwnerListDto,
  },
  cache: { etag: false },
  realtime: { events: {} },
  delete: { strategy: "soft" },
  search: {},
  // `deletedAt` is soft-delete plumbing (`@DeleteDateColumn`), not data a
  // client should ever filter, sort, or select on — `{ exclude }` resolves
  // to every own column except this one, without hand-enumerating the rest.
  filter: { fields: { exclude: ["deletedAt"] } },
  sort: { fields: { exclude: ["deletedAt"] } },
  select: { fields: { exclude: ["deletedAt"] } },
  // `include=pets` — opt-in per relation. Pets are a to-many, so they
  // batch-load: one extra query per page of owners, never a joined row
  // explosion under pagination. `address` is the to-one counterpart — it
  // joins instead. Both are `auto`'s default, so no `relations.<name>.read`
  // tuning is needed.
  include: { fields: ["pets", "address"] },
  operations: {
    createOne: true,
    findOne: true,
    findMany: true,
    updateOne: true,
    patchOne: true,
    purgeOne: true,
    restoreOne: true,
    deleteOne: { policy: hasPermission("owner:delete") },
    // No `handler` — `@Override("welcomeOne")` below is the whole
    // implementation (issue #424).
    welcomeOne: {
      meta: { routes: { method: "POST", path: ":id/welcome" } },
    },
  },
})
@Controller("owners")
@UseGuards(OwnerAppContextGuard)
export class OwnerController {
  constructor(
    @Inject(getKavoServiceToken(Owner)) private readonly base: DefaultKavoService<Owner>,
    private readonly welcomeService: OwnerWelcomeService,
  ) {}

  @Override()
  async createOne(dto: CreateOwnerDto): Promise<unknown> {
    return this.base.createOne(dto as never);
  }

  @Override()
  async updateOne(id: EntityId, dto: UpdateOwnerDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    return this.base.updateOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }

  @Override()
  async patchOne(id: EntityId, dto: PatchOwnerDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    return this.base.patchOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }

  /**
   * `welcomeOne`'s entire implementation — there is no config-level
   * `handler` to fall back to (issue #424). Notifying through
   * `OwnerWelcomeService` is exactly what a config-level handler cannot do
   * (no `this`, no constructor injection); marking `startedAt` afterwards
   * goes through the same typed service every other override here uses.
   */
  @Override("welcomeOne")
  async welcome(id: EntityId): Promise<unknown> {
    const owner = await this.base.findOne(id as never);
    await this.welcomeService.notify(owner.email);
    return this.base.patchOne(id as never, { startedAt: new Date() } as never);
  }
}
