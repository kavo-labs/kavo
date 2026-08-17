import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  type CanActivate,
  Controller,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { from, type Observable } from "rxjs";
import type { DefaultKavoService, RequestPreconditions } from "@kavo/core";
import type { KavoModuleOptions } from "@kavo/nest";
import { Kavo, KavoModule, Override, getKavoServiceToken, parseEntityTags } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * ETag caching and conditional requests over real HTTP (issue #120,
 * ADR-0020). The engine-level semantics are pinned in
 * `packages/core/tests/caching.spec.ts`; what this file proves is the
 * wiring only `@kavo/nest` can: generated routes read `If-Match` /
 * `If-None-Match` off the request, set the `ETag` response header, and
 * turn a not-modified read into a bodyless `304` — with no hand-written
 * controller method anywhere.
 */

let app: INestApplication;
let adapter: InMemoryTodoAdapter;
let httpServer: SupertestTarget | undefined;

interface BootstrapOptions {
  readonly defaults?: KavoModuleOptions["defaults"];
  /**
   * Express sets a weak ETag of its own on any body it serializes, and
   * 304s a fresh `If-None-Match` against it — behavior that exists with or
   * without Kavo. Every test here turns it off, so an observed `ETag` or
   * `304` can only be Kavo's; the one test that leaves it on is the one
   * asserting Kavo's tag wins over it.
   */
  readonly expressEtag?: boolean;
}

async function bootstrap(controller: unknown, options: BootstrapOptions = {}): Promise<void> {
  adapter = new InMemoryTodoAdapter();
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), defaults: options.defaults }),
      KavoModule.forFeature([controller as never]),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  (app.getHttpAdapter().getInstance() as { set(setting: string, value: unknown): void }).set(
    "etag",
    options.expressEtag ?? false,
  );
  httpServer = await listen(app);
}

afterEach(async () => {
  httpServer = undefined;
  await app.close();
});

function server(): SupertestTarget {
  return boundServer(httpServer);
}

/** Seed one todo and hand back the `ETag` its own creation response carried. */
async function seed(title = "write docs"): Promise<string> {
  const created = await request(server()).post("/todos").send({ title }).expect(201);
  return created.headers["etag"] as string;
}

@Kavo(Todo, { operations: { restoreOne: true, purgeOne: true } })
@Controller("todos")
class CachedTodoController {}

describe("ETag header on generated routes", () => {
  beforeEach(async () => {
    await bootstrap(CachedTodoController);
  });

  it("sets a strong ETag on every single-item response", async () => {
    const created = await request(server()).post("/todos").send({ title: "a" }).expect(201);
    expect(created.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);

    for (const response of [
      await request(server()).get("/todos/1").expect(200),
      await request(server()).put("/todos/1").send({ title: "b" }).expect(200),
      await request(server()).patch("/todos/1").send({ priority: 3 }).expect(200),
    ]) {
      expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    }
  });

  it("sets one on a restoreOne response too", async () => {
    await request(server()).post("/todos").send({ title: "a" }).expect(201);
    await request(server()).delete("/todos/1").expect(204);

    const restored = await request(server()).patch("/todos/1/restore").expect(200);
    expect(restored.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("sets none on a collection or a bodyless delete", async () => {
    await request(server()).post("/todos").send({ title: "a" }).expect(201);

    expect((await request(server()).get("/todos").expect(200)).headers["etag"]).toBeUndefined();
    expect((await request(server()).delete("/todos/1").expect(204)).headers["etag"]).toBeUndefined();
  });

  it("still returns the ordinary body and status for every generated route", async () => {
    // The interceptor unwraps the engine envelope; nothing downstream may
    // ever see `{ operation, item, list, … }` on the wire.
    const created = await request(server()).post("/todos").send({ title: "a" }).expect(201);
    expect(created.body).toMatchObject({ id: 1, title: "a" });

    const list = await request(server()).get("/todos").expect(200);
    expect(list.body).toMatchObject({ items: [{ title: "a" }], limit: 20, offset: 0, total: 1 });

    const found = await request(server()).get("/todos/1").expect(200);
    expect(found.body).toMatchObject({ id: 1, title: "a" });
    expect(found.body).not.toHaveProperty("operation");
  });
});

describe("ETag alongside the host framework's own", () => {
  it("wins over Express's weak ETag", async () => {
    // Express tags whatever bytes it serializes; Kavo tags the
    // *representation*, which is what an `If-Match` is evaluated against
    // later. Ours is set first, and Express only fills in a tag that is
    // not already there.
    await bootstrap(CachedTodoController, { expressEtag: true });
    const created = await request(server()).post("/todos").send({ title: "a" }).expect(201);

    expect(created.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("wins over Express's weak ETag on an @Override'd route too", async () => {
    // #186's actual scenario, and the one the rest of this file could not
    // see because it turns Express's tag off. An override delegating to the
    // typed service used to serve no tag of its own, so Express's weak one
    // stood in — and a weak tag can never satisfy `If-Match`, which uses the
    // strong comparison. The route looked cached and protected nothing.
    @Kavo(Todo)
    @Controller("todos")
    class DelegatingTodoController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async findOne(id: string, query: unknown): Promise<unknown> {
        return this.base.findOne(id as never, query as never);
      }
    }

    await bootstrap(DelegatingTodoController, { expressEtag: true });
    await seed();

    const read = await request(server()).get("/todos/1").expect(200);
    expect(read.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(read.headers["etag"]).not.toMatch(/^W\//);
  });
});

describe("If-None-Match → 304", () => {
  beforeEach(async () => {
    await bootstrap(CachedTodoController);
  });

  it("answers 304 with no body when the client's copy is current", async () => {
    const etag = await seed();

    const revalidated = await request(server()).get("/todos/1").set("If-None-Match", etag).expect(304);
    expect(revalidated.text).toBe("");
    expect(revalidated.body).toEqual({});
    expect(revalidated.headers["etag"]).toBe(etag);
  });

  it("answers 200 with a fresh ETag once the item has changed", async () => {
    const etag = await seed();
    await request(server()).patch("/todos/1").send({ priority: 9 }).expect(200);

    const revalidated = await request(server()).get("/todos/1").set("If-None-Match", etag).expect(200);
    expect(revalidated.body).toMatchObject({ priority: 9 });
    expect(revalidated.headers["etag"]).not.toBe(etag);
  });

  it("honors a list of candidate tags and the wildcard", async () => {
    const etag = await seed();

    await request(server()).get("/todos/1").set("If-None-Match", `"nope", ${etag}`).expect(304);
    await request(server()).get("/todos/1").set("If-None-Match", "*").expect(304);
    await request(server()).get("/todos/1").set("If-None-Match", '"nope"').expect(200);
  });

  it("leaves a collection read alone", async () => {
    const etag = await seed();
    await request(server()).get("/todos").set("If-None-Match", etag).expect(200);
  });
});

describe("If-Match → 412", () => {
  beforeEach(async () => {
    await bootstrap(CachedTodoController);
  });

  it("applies the write when the tag is current, returning a new ETag", async () => {
    const etag = await seed();

    const patched = await request(server())
      .patch("/todos/1")
      .set("If-Match", etag)
      .send({ title: "renamed" })
      .expect(200);
    expect(patched.body).toMatchObject({ title: "renamed" });
    expect(patched.headers["etag"]).not.toBe(etag);
  });

  it("rejects a stale tag with a 412 problem document and leaves the row untouched", async () => {
    const etag = await seed();
    await request(server()).patch("/todos/1").send({ priority: 5 }).expect(200);

    const rejected = await request(server())
      .patch("/todos/1")
      .set("If-Match", etag)
      .send({ title: "overwritten" })
      .expect(412);
    expect(rejected.headers["content-type"]).toContain("application/problem+json");
    expect(rejected.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED", status: 412 });

    const current = await request(server()).get("/todos/1").expect(200);
    expect(current.body).toMatchObject({ title: "write docs", priority: 5 });
  });

  it("blocks a stale PUT and a stale DELETE alike", async () => {
    const etag = await seed();
    await request(server()).patch("/todos/1").send({ priority: 5 }).expect(200);

    await request(server()).put("/todos/1").set("If-Match", etag).send({ title: "x" }).expect(412);
    await request(server()).delete("/todos/1").set("If-Match", etag).expect(412);

    // `Todo` is soft-deletable, so a row count proves nothing here — a
    // successful DELETE and a successful PUT each leave exactly one row
    // too. Read the row back instead, and count only the live ones.
    const current = await request(server()).get("/todos/1").expect(200);
    expect(current.body).toMatchObject({ title: "write docs", priority: 5 });
    expect(adapter.rows.filter((row) => row.deletedAt === null)).toHaveLength(1);
  });

  it("blocks a stale restore and a stale purge, which act on the deleted row", async () => {
    await seed();
    await request(server()).delete("/todos/1").expect(204);

    await request(server()).patch("/todos/1/restore").set("If-Match", '"stale"').expect(412);
    await request(server()).delete("/todos/1/purge").set("If-Match", '"stale"').expect(412);
    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0]?.deletedAt).not.toBeNull();
  });

  it("allows a restore whose tag came from a withDeleted read", async () => {
    await seed();
    await request(server()).delete("/todos/1").expect(204);
    const trashed = await request(server()).get("/todos/1?withDeleted=true").expect(200);

    const restored = await request(server())
      .patch("/todos/1/restore")
      .set("If-Match", trashed.headers["etag"] as string)
      .expect(200);
    expect(restored.body).toMatchObject({ id: 1, deletedAt: null });
  });

  it("keeps DELETE's own 409 on an already-deleted row, header or no header", async () => {
    // A live-rows-only pre-read turned this into a 404 as soon as an
    // If-Match was present — the same request answering with a different
    // error because a cache header rode along.
    await seed();
    await request(server()).delete("/todos/1").expect(204);
    const current = await request(server()).get("/todos/1?withDeleted=true").expect(200);

    const bare = await request(server()).delete("/todos/1");
    expect(bare.status).toBe(409);
    expect(bare.body).toMatchObject({ code: "KAVO_ALREADY_DELETED" });

    const conditional = await request(server())
      .delete("/todos/1")
      .set("If-Match", current.headers["etag"] as string);
    expect(conditional.status).toBe(409);
    expect(conditional.body).toMatchObject({ code: "KAVO_ALREADY_DELETED" });
  });

  it("allows a fresh DELETE", async () => {
    const etag = await seed();

    await request(server()).delete("/todos/1").set("If-Match", etag).expect(204);
    expect(adapter.rows.filter((row) => row.deletedAt === null)).toHaveLength(0);
  });

  it("404s a missing target rather than 412ing it", async () => {
    const response = await request(server()).patch("/todos/99").set("If-Match", '"anything"').send({ title: "x" });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "KAVO_NOT_FOUND" });
  });

  it("ignores If-Match on a request with no such header", async () => {
    await seed();
    await request(server()).patch("/todos/1").send({ priority: 1 }).expect(200);
    expect(adapter.rows[0]).toMatchObject({ priority: 1 });
  });

  it("refuses a present but empty If-Match rather than writing unguarded", async () => {
    // A header an intermediary normalized away, or a client that built it
    // from an empty variable. Zero tags match nothing, so the write must
    // not go through with a 2xx as if no guard had been asked for.
    await seed();

    for (const value of ["", " ", ",,,"]) {
      const rejected = await request(server()).patch("/todos/1").set("If-Match", value).send({ priority: 9 });
      expect(rejected.status).toBe(412);
      expect(rejected.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED" });
    }
    expect(adapter.rows[0]).toMatchObject({ priority: 0 });
  });

  it("refuses an If-Match on POST, which targets no existing row", async () => {
    const rejected = await request(server()).post("/todos").set("If-Match", '"anything"').send({ title: "a" });
    expect(rejected.status).toBe(412);
    expect(rejected.body).toMatchObject({ code: "KAVO_PRECONDITION_UNSUPPORTED" });
    expect(adapter.rows).toHaveLength(0);
  });
});

describe("If-Match through a replaced controller method", () => {
  /**
   * The two ways an app can own `updateOne` (ADR-0020 §7). Kavo enforces
   * `If-Match` inside the engine, so a method that drops its
   * `preconditions` parameter drops the guard with it — that is a
   * documented consequence of replacing the function, and these two tests
   * are what make it a decision rather than an accident.
   */
  @Kavo(Todo)
  @Controller("todos")
  class BypassingTodoController {
    constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

    @Override()
    async updateOne(id: string, body: Partial<Todo>): Promise<unknown> {
      return this.base.updateOne(id as never, body as never);
    }
  }

  @Kavo(Todo)
  @Controller("todos")
  class ForwardingTodoController {
    constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

    /**
     * The read has to be overridden too, or the round-trip test below is
     * reading a *generated* route's tag and proving nothing new — which is
     * what it did when first written. #186's shape is every route
     * overridden, so the tag the client holds must come from the override
     * path for the test to mean anything.
     */
    @Override()
    async findOne(id: string, query: unknown): Promise<unknown> {
      return this.base.findOne(id as never, query as never);
    }

    @Override()
    async updateOne(id: string, body: Partial<Todo>, preconditions: RequestPreconditions | null): Promise<unknown> {
      return this.base.engine.execute({
        operation: "updateOne",
        id,
        body: body as never,
        query: null,
        options: null,
        preconditions,
      });
    }
  }

  it("drops the guard when the override drops its preconditions parameter, but keeps the ETag", async () => {
    await bootstrap(BypassingTodoController);
    await seed();
    await request(server()).patch("/todos/1").send({ priority: 5 }).expect(200);

    // A stale tag, and the write lands anyway: the engine never saw it.
    const applied = await request(server()).put("/todos/1").set("If-Match", '"stale"').send({ title: "overwritten" });
    expect(applied.status).toBe(200);
    expect(adapter.rows[0]).toMatchObject({ title: "overwritten" });
    // The tag, though, is Kavo's (ADR-0027). This used to assert
    // `toBeUndefined()`, which was true of the framework and false of the
    // wire: Express filled in its own weak tag, so the route looked like it
    // had conditional requests while every If-Match write was a silent lost
    // update (#186). Asserting the shape is the point — "an ETag exists" is
    // exactly the check that missed this.
    expect(applied.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("serves a tag from an overridden read that a forwarding override then accepts", async () => {
    // The round trip #186 could not close, and it only tests the fix
    // because BOTH routes are overridden: the tag comes off the promoted
    // return, not off a generated route. Pre-fix this fails on the shape
    // assertion, since the read carried no Kavo tag at all.
    await bootstrap(ForwardingTodoController);
    await seed();

    const read = await request(server()).get("/todos/1").expect(200);
    const tag = read.headers["etag"] as string;
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/);

    await request(server()).put("/todos/1").set("If-Match", tag).send({ title: "accepted" }).expect(200);
    expect(adapter.rows[0]).toMatchObject({ title: "accepted" });
  });

  it("issues the same tag an unoverridden route would for the same row", async () => {
    // Shape alone would pass for a wrapper that hashed the envelope, or the
    // pre-serialization entity. The promise is "the same strong ETag a
    // generated route would serve", so the two are compared directly.
    await bootstrap(CachedTodoController);
    const generated = await seed();

    await app.close();
    await bootstrap(ForwardingTodoController);
    await seed();
    const overridden = (await request(server()).get("/todos/1").expect(200)).headers["etag"];

    expect(overridden).toBe(generated);
  });

  it("keeps a method-level guard on an override, which replacing the method used to drop", async () => {
    // The regression that mattered most, and the one the rest of this suite
    // was structurally blind to: every other @UseGuards in these tests is
    // class-level, which is the placement that survives a prototype swap.
    // Nest keys method metadata on the FUNCTION, so an @Override carrying
    // @UseGuards(...) lost it — and overriding is the documented workaround
    // for row scoping (#138), so those are exactly the routes carrying an
    // app's authorization.
    @Injectable()
    class DenyGuard implements CanActivate {
      canActivate(): boolean {
        return false;
      }
    }

    @Kavo(Todo)
    @Controller("todos")
    class GuardedTodoController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      @UseGuards(DenyGuard)
      @SetMetadata("roles", ["admin"])
      async findOne(id: string, query: unknown): Promise<unknown> {
        return this.base.findOne(id as never, query as never);
      }
    }

    await bootstrap(GuardedTodoController);
    await seed();

    await request(server()).get("/todos/1").expect(403);
    // And the SetMetadata half, which a Reflector-based @Roles decorator
    // reads the same way — asserted off the routed function, since that is
    // the object Nest reflects on.
    const routed = GuardedTodoController.prototype["findOne"] as object;
    expect(Reflect.getMetadata("roles", routed)).toEqual(["admin"]);
  });

  it("leaves an Observable return alone rather than sealing it inside an envelope", async () => {
    // Nest flattens a handler result that IS an Observable. One nested a
    // level down inside an envelope is flattened by nothing, and the body
    // ships as {} — the wrapper's one way to break a working route.
    @Kavo(Todo)
    @Controller("todos")
    class StreamingTodoController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      findOne(id: string, query: unknown): Observable<unknown> {
        return from(this.base.findOne(id as never, query as never));
      }
    }

    await bootstrap(StreamingTodoController);
    await seed();

    const read = await request(server()).get("/todos/1").expect(200);
    expect(read.body).toMatchObject({ title: "write docs" });
    // No tag: an Observable is not a representation to hash.
    expect(read.headers["etag"]).toBeUndefined();
  });

  it("sets no tag on an overridden collection read", async () => {
    // ADR-0020 leaves collection ETags out of scope, and the wrapper's
    // cardinality skip is what keeps that true on the override path.
    @Kavo(Todo)
    @Controller("todos")
    class ListingTodoController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async findMany(query: unknown): Promise<unknown> {
        return this.base.findMany(query as never);
      }
    }

    await bootstrap(ListingTodoController);
    await seed();

    expect((await request(server()).get("/todos").expect(200)).headers["etag"]).toBeUndefined();
  });

  it("sets no tag on an overridden bodyless delete", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class DeletingTodoController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async deleteOne(id: string): Promise<unknown> {
        return this.base.deleteOne(id as never);
      }
    }

    await bootstrap(DeletingTodoController);
    await seed();

    expect((await request(server()).delete("/todos/1").expect(204)).headers["etag"]).toBeUndefined();
  });

  it("does not unwrap an override that already returns an engine envelope", async () => {
    // The pass-through branch. Shape assertions alone would stay green if
    // the wrapper double-wrapped, so the body is checked for envelope keys.
    await bootstrap(ForwardingTodoController);
    await seed();

    const written = await request(server()).put("/todos/1").send({ title: "enveloped" }).expect(200);
    expect(written.body).not.toHaveProperty("operation");
    expect(written.body).not.toHaveProperty("notModified");
    expect(written.body).toMatchObject({ title: "enveloped" });
  });

  it("reads cache.etag at the operation scope, not just the entity's", async () => {
    // `settingsFor` falls back to entity settings, so configuring the
    // entity would pass even if per-operation resolution were bypassed.
    // One operation off and its sibling on is what actually pins it.
    @Kavo(Todo, { operations: { updateOne: { cache: { etag: false } } } })
    @Controller("todos")
    class MixedTodoController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async updateOne(id: string, body: Partial<Todo>): Promise<unknown> {
        return this.base.updateOne(id as never, body as never);
      }

      @Override()
      async patchOne(id: string, body: Partial<Todo>): Promise<unknown> {
        return this.base.patchOne(id as never, body as never);
      }
    }

    await bootstrap(MixedTodoController);
    await seed();

    expect((await request(server()).put("/todos/1").send({ title: "a" }).expect(200)).headers["etag"]).toBeUndefined();
    expect((await request(server()).patch("/todos/1").send({ title: "b" }).expect(200)).headers["etag"]).toMatch(
      /^"[0-9a-f]{64}"$/,
    );
  });

  it("leaves the override's return alone when caching is off entity-wide", async () => {
    // The entity scope, which `settingsFor` falls back to. The test above
    // is the per-operation half; both matter because the fallback is what
    // makes an app-wide opt-out work at all.
    @Kavo(Todo, { cache: { etag: false } })
    @Controller("todos")
    class UncachedTodoController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async updateOne(id: string, body: Partial<Todo>): Promise<unknown> {
        return this.base.updateOne(id as never, body as never);
      }
    }

    await bootstrap(UncachedTodoController);
    await seed();
    const applied = await request(server()).put("/todos/1").send({ title: "no tag" }).expect(200);
    expect(applied.headers["etag"]).toBeUndefined();
  });

  it("applies the guard, and the ETag, when the override forwards them", async () => {
    await bootstrap(ForwardingTodoController);
    await seed();
    await request(server()).patch("/todos/1").send({ priority: 5 }).expect(200);

    const rejected = await request(server()).put("/todos/1").set("If-Match", '"stale"').send({ title: "overwritten" });
    expect(rejected.status).toBe(412);
    expect(rejected.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED" });
    expect(adapter.rows[0]).toMatchObject({ title: "write docs" });

    const current = await request(server()).get("/todos/1").expect(200);
    const applied = await request(server())
      .put("/todos/1")
      .set("If-Match", current.headers["etag"] as string)
      .send({ title: "renamed" })
      .expect(200);
    expect(applied.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect(adapter.rows[0]).toMatchObject({ title: "renamed" });
  });
});

describe("cache.etag: false", () => {
  it("stops generating ETags when disabled globally", async () => {
    await bootstrap(CachedTodoController, { defaults: { cache: { etag: false } } });
    const created = await request(server()).post("/todos").send({ title: "a" }).expect(201);

    expect(created.headers["etag"]).toBeUndefined();
    expect((await request(server()).get("/todos/1").expect(200)).headers["etag"]).toBeUndefined();
  });

  it("ignores If-None-Match and refuses If-Match when disabled globally", async () => {
    // The tag Kavo *would* have issued for this exact row, captured from
    // an otherwise identical app — so the 200 below is the check being
    // skipped, not a tag that happened not to match.
    await bootstrap(CachedTodoController);
    const wouldBe = await seed("a");
    await app.close();

    await bootstrap(CachedTodoController, { defaults: { cache: { etag: false } } });
    await seed("a");

    await request(server()).get("/todos/1").set("If-None-Match", wouldBe).expect(200);

    // `If-Match` is the asymmetric half: ignoring it would answer 2xx for
    // a write nothing guarded, so it is refused instead.
    const refused = await request(server())
      .patch("/todos/1")
      .set("If-Match", '"definitely-stale"')
      .send({ priority: 4 });
    expect(refused.status).toBe(412);
    expect(refused.body).toMatchObject({ code: "KAVO_PRECONDITION_UNSUPPORTED" });
    expect(adapter.rows[0]).toMatchObject({ priority: 0 });
  });

  it("can be switched off for one entity only", async () => {
    @Kavo(Todo, { cache: { etag: false } })
    @Controller("todos")
    class UncachedTodoController {}
    await bootstrap(UncachedTodoController);

    const created = await request(server()).post("/todos").send({ title: "a" }).expect(201);
    expect(created.headers["etag"]).toBeUndefined();
  });

  it("can be switched off for one operation only", async () => {
    @Kavo(Todo, { operations: { findOne: { cache: { etag: false } } } })
    @Controller("todos")
    class PartiallyCachedTodoController {}
    await bootstrap(PartiallyCachedTodoController);

    const created = await request(server()).post("/todos").send({ title: "a" }).expect(201);
    expect(created.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await request(server()).get("/todos/1").expect(200)).headers["etag"]).toBeUndefined();
  });
});

describe("parseEntityTags", () => {
  it("splits a header into whole entity-tags", () => {
    expect(parseEntityTags('"a", W/"b", *')).toEqual(['"a"', 'W/"b"', "*"]);
  });

  it("keeps a comma inside a quoted tag together", () => {
    expect(parseEntityTags('"a,b", "c"')).toEqual(['"a,b"', '"c"']);
  });

  it("joins a repeated header rather than picking one", () => {
    expect(parseEntityTags(['"a"', '"b"'])).toEqual(['"a"', '"b"']);
  });

  it("tolerates a non-conformant unquoted token instead of dropping it", () => {
    expect(parseEntityTags("abc")).toEqual(["abc"]);
  });

  it("distinguishes an absent header from a present but empty one", () => {
    // `undefined` is "no guard asked for"; `[]` is "a guard asked for that
    // nothing can satisfy". Collapsing them turns a normalized-away header
    // into an unguarded write.
    expect(parseEntityTags(undefined)).toBeUndefined();
    expect(parseEntityTags("")).toEqual([]);
    expect(parseEntityTags("   ")).toEqual([]);
    expect(parseEntityTags(",,,")).toEqual([]);
  });
});
