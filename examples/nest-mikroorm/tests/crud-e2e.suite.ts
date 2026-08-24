import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { MikroORM } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * The Pet example served by the real stack — generated Nest routes → engine
 * → `@kavo/mikroorm` → a real database — with filtering, sorting,
 * pagination, DTO projections, layered config, and problem-details errors.
 *
 * Same domain as `nest-typeorm`: single-table inheritance (Cat/Dog over one
 * `pet` table), an Owner relation both ways, a one-to-one Address, and a
 * many-to-many Tag edge. Running the *same shape* under a different adapter
 * is the point — anything that behaves differently here is either a real
 * MikroORM difference worth seeing, or a bug.
 *
 * Parameterized by `getApp`/`getOrm` so the same suite runs unchanged
 * against both the in-memory SQLite app (`app.e2e.spec.ts`) and the
 * Testcontainers-provisioned Postgres app (`app-postgres.e2e.spec.ts`) —
 * one behavioral spec, two drivers, no forked assertions.
 */
export function registerCrudE2eSuite(getApp: () => INestApplication, getOrm: () => MikroORM): void {
  function server(): SupertestTarget {
    // The spec that registered this suite must have bootstrapped with
    // `listen(app)`, not `app.init()`, and must not have closed the app:
    // `boundServer` rejects every shape supertest would answer by binding
    // a wildcard port per request, which is the collision behind #91.
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  async function seed(): Promise<void> {
    const cats = [
      { name: "Whiskers", age: 36, size: "small", indoor: true, livesLeft: 9 },
      { name: "Mittens", age: 45, size: "medium", indoor: false, livesLeft: 7 },
      { name: "Shadow", age: 41, size: "small", indoor: true, livesLeft: 8 },
      { name: "Tigger", age: 28, size: "large", indoor: false, livesLeft: 9 },
    ];
    for (const cat of cats) {
      await request(server()).post("/cats").send(cat).expect(201);
    }
  }

  async function newOwner(name = "Ada", email = "ada@x.io"): Promise<number> {
    const created = await request(server()).post("/owners").send({ name, email }).expect(201);
    return created.body.id as number;
  }

  describe("Pet example app (MikroORM)", () => {
    beforeEach(async () => {
      // Truncate between tests rather than rebuilding the schema: the ORM is
      // bootstrapped once per spec file. `clearDatabase` also resets the
      // identity map, which matters because the suite drives the app over
      // HTTP while occasionally asserting through a forked EntityManager.
      await getOrm().schema.clear();
    });

    it("runs the full CRUD lifecycle over HTTP", async () => {
      const created = await request(server())
        .post("/cats")
        .send({ name: "First", age: 3, size: "small", indoor: true, livesLeft: 9 })
        .expect(201);
      expect(created.body).toMatchObject({ name: "First", age: 3, size: "small", indoor: true, livesLeft: 9 });
      const id = created.body.id as number;

      const fetched = await request(server()).get(`/cats/${id}`).expect(200);
      // The CatItemDto projection exactly — note no `species` and no `owner`.
      expect(Object.keys(fetched.body).sort()).toEqual([
        "age",
        "createdAt",
        "id",
        "indoor",
        "livesLeft",
        "name",
        "size",
      ]);

      await request(server())
        .put(`/cats/${id}`)
        .send({ name: "Renamed", age: 4, size: "large", indoor: false, livesLeft: 8 })
        .expect(200);
      const after = await request(server()).get(`/cats/${id}`).expect(200);
      expect(after.body).toMatchObject({ name: "Renamed", age: 4, size: "large" });

      // PATCH is disabled on this route: `operations` names every other
      // standard id, but deliberately not `patchOne`.
      await request(server()).patch(`/cats/${id}`).send({ name: "Nope" }).expect(404);

      await request(server()).delete(`/cats/${id}`).expect(204);
      await request(server()).get(`/cats/${id}`).expect(404);
    });

    it("filters, sorts, and paginates through the query grammar", async () => {
      await seed();
      const list = await request(server()).get("/cats?filter[age][gte]=36&sort=-age&limit=2&offset=1").expect(200);

      expect(list.body).toMatchObject({ limit: 2, offset: 1, total: 3 });
      expect(list.body.items.map((cat: { name: string }) => cat.name)).toEqual(["Shadow", "Whiskers"]);
      // CatListDto is leaner than the item projection.
      expect(Object.keys(list.body.items[0]).sort()).toEqual(["id", "indoor", "name"]);
    });

    it("filters on the enum column", async () => {
      await seed();
      const small = await request(server()).get("/cats?filter[size][eq]=small&sort=name").expect(200);
      expect(small.body.items.map((cat: { name: string }) => cat.name)).toEqual(["Shadow", "Whiskers"]);
    });

    it("supports OR groups and IN sets from the wire", async () => {
      await seed();
      const either = await request(server())
        .get("/cats?filter[or][0][name][eq]=Mittens&filter[or][1][name][eq]=Tigger&sort=name")
        .expect(200);
      expect(either.body.items.map((cat: { name: string }) => cat.name)).toEqual(["Mittens", "Tigger"]);

      const inSet = await request(server()).get("/cats?filter[size][in]=small,large&sort=name").expect(200);
      expect(inSet.body.items).toHaveLength(3);
    });

    it("matches ILIKE case-insensitively on every driver", async () => {
      // The one query `caseInsensitiveFilters` decides. On Postgres it is a
      // real `$ilike`, enabled by `app-postgres.e2e.spec.ts`; on SQLite it
      // degrades to `$like`, which is already ASCII case-insensitive there.
      // Same assertion either way — the whole argument for defaulting the
      // flag to `false` (doc 17 §2).
      await seed();
      const matched = await request(server()).get("/cats?filter[name][ilike]=whisk%25").expect(200);
      expect(matched.body.items.map((cat: { name: string }) => cat.name)).toEqual(["Whiskers"]);
    });

    it("applies sparse fieldsets after DTO mapping", async () => {
      await seed();
      const list = await request(server()).get("/cats?fields=id,name&limit=1&sort=name").expect(200);
      expect(Object.keys(list.body.items[0]).sort()).toEqual(["id", "name"]);
    });

    it("restricts filterable, sortable, and selectable to an explicit list", async () => {
      await seed();
      // `livesLeft` is returned by CatItemDto but is not on any allowlist.
      await request(server()).get("/cats?filter[livesLeft][eq]=9").expect(400);
      await request(server()).get("/cats?sort=livesLeft").expect(400);
      await request(server()).get("/cats?fields=id,livesLeft").expect(400);
    });

    it("honors the entity-scope pagination override (defaultLimit 10, max 50)", async () => {
      await seed();
      const capped = await request(server()).get("/cats?limit=999").expect(200);
      expect(capped.body.limit).toBe(50);
      // /dogs takes the root default instead — no entity-scope override.
      const dogs = await request(server()).get("/dogs?limit=999").expect(200);
      expect(dogs.body.limit).toBe(100);
    });

    it("rejects bad queries with RFC 9457 problem details", async () => {
      const invalid = await request(server())
        .get("/cats?filter[nope][eq]=x")
        .expect(400)
        .expect("Content-Type", /application\/problem\+json/);
      expect(invalid.body).toMatchObject({ code: "KAVO_QUERY_INVALID", status: 400 });
      expect(invalid.body.errors[0]).toMatchObject({ field: "nope" });

      await request(server()).get("/cats?filter[size][eq]=enormous").expect(400);
      await request(server()).get("/owners?withDeleted=true&onlyDeleted=true").expect(400);
      await request(server()).get("/cats/424242").expect(404);
    });

    it("scopes each route to its subtype via the discriminator", async () => {
      // Single-table inheritance: both rows live in one table, and each
      // route must see only its own subtype. MikroORM writes `species` from
      // the subtype being persisted.
      await request(server())
        .post("/cats")
        .send({ name: "Whiskers", age: 3, size: "small", indoor: true, livesLeft: 9 })
        .expect(201);
      await request(server())
        .post("/dogs")
        .send({ name: "Rex", age: 5, size: "large", breed: "lab", goodBoy: true })
        .expect(201);

      const cats = await request(server()).get("/cats").expect(200);
      expect(cats.body.items.map((cat: { name: string }) => cat.name)).toEqual(["Whiskers"]);
      const dogs = await request(server()).get("/dogs").expect(200);
      expect(dogs.body.items.map((dog: { name: string }) => dog.name)).toEqual(["Rex"]);
    });

    it("falls back to entity-derived DTOs on /dogs, and never lets a client write the discriminator", async () => {
      // `DogController` declares no `dto` block, so every slot is derived
      // from MikroORM's own metadata — which is what makes the discriminator
      // visible here at all.
      const created = await request(server())
        .post("/dogs")
        .send({ name: "Rex", age: 5, size: "large", breed: "lab", goodBoy: true, species: "cat", id: 9999 })
        .expect(201);

      // `id` is auto-increment and `species` is the discriminator: both are
      // reported generated, so both are stripped from the write. A
      // client-set discriminator would otherwise produce a row this entity's
      // own repository can no longer load (doc 17 §1).
      expect(created.body.id).not.toBe(9999);
      // And it never comes back out: MikroORM keeps the discriminator as
      // write-only bookkeeping that never hydrates onto an entity, so it
      // reaches no response even on the route with entity-derived DTOs.
      expect(created.body).not.toHaveProperty("species");
      expect(created.body).toMatchObject({ name: "Rex", breed: "lab", goodBoy: true });

      // And it stays a Dog: writing `species` on update is ignored too — the
      // discriminator is stripped as generated, leaving no field changes,
      // so the write is rejected rather than silently no-opped (issue #287).
      await request(server()).patch(`/dogs/${created.body.id}`).send({ species: "cat" }).expect(400);
      expect((await request(server()).get("/dogs").expect(200)).body.items).toHaveLength(1);
    });

    it("embeds relations both ways: a to-one owner and a to-many pets", async () => {
      const ownerId = await newOwner();
      await request(server())
        .post("/cats")
        .send({ name: "Whiskers", age: 3, size: "small", indoor: true, livesLeft: 9, owner: ownerId })
        .expect(201);

      const cats = await request(server()).get("/cats?include=owner").expect(200);
      expect(cats.body.items[0].owner).toMatchObject({ id: ownerId, name: "Ada" });

      const owners = await request(server()).get("/owners?include=pets").expect(200);
      expect(Array.isArray(owners.body.items[0].pets)).toBe(true);
      expect(owners.body.items[0].pets).toMatchObject([{ name: "Whiskers" }]);
    });

    it("embeds a two-level include (cat -> owner -> pets)", async () => {
      const ownerId = await newOwner();
      await request(server())
        .post("/cats")
        .send({ name: "Whiskers", age: 3, size: "small", indoor: true, livesLeft: 9, owner: ownerId })
        .expect(201);

      const nested = await request(server()).get("/cats?include=owner.pets").expect(200);
      expect(nested.body.items[0].owner.pets).toMatchObject([{ name: "Whiskers" }]);
    });

    it("keeps a relation out of the response until it is included", async () => {
      const ownerId = await newOwner();
      await request(server())
        .post("/cats")
        .send({ name: "Whiskers", age: 3, size: "small", indoor: true, livesLeft: 9, owner: ownerId })
        .expect(201);

      const plain = await request(server()).get("/cats").expect(200);
      expect(plain.body.items[0]).not.toHaveProperty("owner");
    });

    it("filters and sorts across a relation path", async () => {
      // The capability that separates this adapter from `@kavo/mongoose`,
      // which refuses `owner.name` outright: MikroORM nests a relation path
      // in its own query language and adds the join itself.
      const ada = await newOwner("Ada", "ada@x.io");
      const zoe = await newOwner("Zoe", "zoe@x.io");
      await request(server())
        .post("/cats")
        .send({ name: "AdaCat", age: 3, size: "small", indoor: true, livesLeft: 9, owner: ada })
        .expect(201);
      await request(server())
        .post("/cats")
        .send({ name: "ZoeCat", age: 4, size: "small", indoor: true, livesLeft: 9, owner: zoe })
        .expect(201);

      const filtered = await request(server()).get("/cats?filter[owner.name][eq]=Ada").expect(200);
      expect(filtered.body.items.map((cat: { name: string }) => cat.name)).toEqual(["AdaCat"]);

      const sorted = await request(server()).get("/cats?sort=-owner.name").expect(200);
      expect(sorted.body.items.map((cat: { name: string }) => cat.name)).toEqual(["ZoeCat", "AdaCat"]);
    });

    it("does not fan out root rows when a to-many include is paginated", async () => {
      // MikroORM resolves `populate` with its own queries and applies
      // limit/offset to the root either way, which is why this adapter
      // ignores IncludeNode.strategy (doc 17 §3).
      const ownerId = await newOwner();
      for (const name of ["One", "Two", "Three"]) {
        await request(server())
          .post("/cats")
          .send({ name, age: 3, size: "small", indoor: true, livesLeft: 9, owner: ownerId })
          .expect(201);
      }

      const page = await request(server()).get("/owners?include=pets&limit=1").expect(200);
      expect(page.body).toMatchObject({ total: 1, limit: 1 });
      expect(page.body.items).toHaveLength(1);
      expect(page.body.items[0].pets).toHaveLength(3);
    });

    it("associates an owner with an address by id and embeds it via include (one-to-one)", async () => {
      const address = await request(server())
        .post("/addresses")
        .send({ street: "1 Main", city: "Springfield", postalCode: "12345" })
        .expect(201);
      const created = await request(server())
        .post("/owners")
        .send({ name: "Ada", email: "ada@x.io", address: address.body.id })
        .expect(201);

      const fetched = await request(server()).get(`/owners/${created.body.id}?include=address`).expect(200);
      expect(fetched.body.address).toMatchObject({ street: "1 Main", city: "Springfield" });

      // A null one-to-one round-trips as null, not as a missing key.
      const orphan = await newOwner("Grace", "grace@x.io");
      const withoutAddress = await request(server()).get(`/owners/${orphan}?include=address`).expect(200);
      expect(withoutAddress.body.address).toBeNull();
    });

    it("associates tags by id and embeds them via a many-to-many include", async () => {
      const tagIds: number[] = [];
      for (const name of ["fluffy", "loud"]) {
        const tag = await request(server()).post("/tags").send({ name }).expect(201);
        tagIds.push(tag.body.id as number);
      }
      const cat = await request(server())
        .post("/cats")
        .send({ name: "Whiskers", age: 3, size: "small", indoor: true, livesLeft: 9, tags: tagIds })
        .expect(201);

      const fetched = await request(server()).get(`/cats/${cat.body.id}?include=tags`).expect(200);
      expect(Array.isArray(fetched.body.tags)).toBe(true);
      expect(fetched.body.tags.map((tag: { name: string }) => tag.name).sort()).toEqual(["fluffy", "loud"]);

      // Replacing the set is the documented association semantic (ADR-0014).
      await request(server())
        .put(`/cats/${cat.body.id}`)
        .send({ name: "Whiskers", age: 3, size: "small", indoor: true, livesLeft: 9, tags: [tagIds[0]] })
        .expect(200);
      const reduced = await request(server()).get(`/cats/${cat.body.id}?include=tags`).expect(200);
      expect(reduced.body.tags.map((tag: { name: string }) => tag.name)).toEqual(["fluffy"]);
    });

    it("counts and slices distinct roots even when a cat has several tags", async () => {
      const tagIds: number[] = [];
      for (const name of ["a", "b", "c"]) {
        const tag = await request(server()).post("/tags").send({ name }).expect(201);
        tagIds.push(tag.body.id as number);
      }
      for (const name of ["One", "Two"]) {
        await request(server())
          .post("/cats")
          .send({ name, age: 3, size: "small", indoor: true, livesLeft: 9, tags: tagIds })
          .expect(201);
      }

      const page = await request(server()).get("/cats?include=tags&limit=1&sort=name").expect(200);
      expect(page.body.total).toBe(2);
      expect(page.body.items).toHaveLength(1);
      expect(page.body.items[0].tags).toHaveLength(3);
    });

    it("keeps include an opt-in allowlist entry, not a free pass", async () => {
      await seed();
      // `Cat.owner`/`Cat.tags` are includable; nothing else is, and an
      // unknown relation is refused rather than ignored.
      await request(server()).get("/cats?include=nope").expect(400);
      // `Tag` opens no relations at all.
      await request(server()).get("/tags?include=pets").expect(400);
    });

    it("soft-deletes, restores, and purges owners", async () => {
      const id = await newOwner();

      await request(server()).delete(`/owners/${id}`).expect(204);
      expect((await request(server()).get("/owners").expect(200)).body.total).toBe(0);
      expect((await request(server()).get("/owners?withDeleted=true").expect(200)).body.total).toBe(1);
      expect((await request(server()).get("/owners?onlyDeleted=true").expect(200)).body.total).toBe(1);
      // Deleting twice is a state conflict, not a missing row.
      await request(server()).delete(`/owners/${id}`).expect(409);
      // A soft-deleted row is invisible to writes as well as reads.
      await request(server()).patch(`/owners/${id}`).send({ name: "Zombie" }).expect(404);

      const restored = await request(server()).patch(`/owners/${id}/restore`).expect(200);
      expect(restored.body).toMatchObject({ id, name: "Ada" });
      expect((await request(server()).get("/owners").expect(200)).body.total).toBe(1);

      // Purge only ever removes an already-deleted row.
      await request(server()).delete(`/owners/${id}/purge`).expect(409);
      await request(server()).delete(`/owners/${id}`).expect(204);
      await request(server()).delete(`/owners/${id}/purge`).expect(204);
      expect((await request(server()).get("/owners?withDeleted=true").expect(200)).body.total).toBe(0);
    });

    it("keeps deletedAt out of the allowlists and out of every DTO slot", async () => {
      await newOwner();
      // The allowlists use `{ exclude: ["deletedAt"] }`.
      await request(server()).get("/owners?filter[deletedAt][isNull]=true").expect(400);
      await request(server()).get("/owners?sort=deletedAt").expect(400);
      await request(server()).get("/owners?fields=id,deletedAt").expect(400);

      const list = await request(server()).get("/owners").expect(200);
      expect(list.body.items[0]).not.toHaveProperty("deletedAt");
    });

    it("refuses to soft-delete an owner through a plain write", async () => {
      // Because MikroORM declares no delete marker, `deletedAt` is an
      // ordinary column that the adapter cannot mark generated — the write
      // DTOs are what keep it unwritable (doc 17 §7). With `purgeOne`
      // enabled, a stampable marker would be an unauthenticated path to a
      // permanent delete.
      // The write DTO excludes the marker, leaving no field changes — a
      // patch body naming only it is rejected, not silently no-opped
      // (issue #287).
      const id = await newOwner();
      await request(server()).patch(`/owners/${id}`).send({ deletedAt: "2020-01-01T00:00:00.000Z" }).expect(400);

      // Still live, and still not purgeable.
      expect((await request(server()).get("/owners").expect(200)).body.total).toBe(1);
      await request(server()).delete(`/owners/${id}/purge`).expect(409);
    });

    it("leaves hard-delete entities without restore or purge routes", async () => {
      const tag = await request(server()).post("/tags").send({ name: "plain" }).expect(201);
      await request(server()).patch(`/tags/${tag.body.id}/restore`).expect(404);
      await request(server()).delete(`/tags/${tag.body.id}/purge`).expect(404);
    });

    it("maps unique violations to 409 conflict problem details", async () => {
      await newOwner("Ada", "dup@x.io");
      const conflict = await request(server())
        .post("/owners")
        .send({ name: "Ada again", email: "dup@x.io" })
        .expect(409)
        .expect("Content-Type", /application\/problem\+json/);
      expect(conflict.body).toMatchObject({ code: "KAVO_CONFLICT", status: 409 });
    });

    it("still conflicts on a unique index held by a soft-deleted owner", async () => {
      // Documented adapter guidance: a soft-deleted row keeps its unique
      // index entries, and the fix is a partial index — not a Kavo rewrite.
      const id = await newOwner("Ada", "held@x.io");
      await request(server()).delete(`/owners/${id}`).expect(204);
      await request(server()).post("/owners").send({ name: "Ada again", email: "held@x.io" }).expect(409);
    });

    it("round-trips the nullable startedAt date on owners", async () => {
      const created = await request(server())
        .post("/owners")
        .send({ name: "Ada", email: "ada@x.io", startedAt: "2024-03-01T00:00:00.000Z" })
        .expect(201);
      expect(new Date(created.body.startedAt as string).toISOString()).toBe("2024-03-01T00:00:00.000Z");

      const cleared = await request(server()).patch(`/owners/${created.body.id}`).send({ startedAt: null }).expect(200);
      expect(cleared.body.startedAt).toBeNull();
    });

    it("ignores client-sent generated columns", async () => {
      const created = await request(server())
        .post("/owners")
        .send({ id: 4242, name: "Ada", email: "ada@x.io", createdAt: "1999-01-01T00:00:00.000Z" })
        .expect(201);
      expect(created.body.id).not.toBe(4242);
      expect(new Date(created.body.createdAt as string).getUTCFullYear()).not.toBe(1999);
    });

    it("does not serve a stale row from a previous request's identity map", async () => {
      // MikroORM caches every entity an EntityManager has loaded. The
      // adapter forks a fresh one per operation precisely so a second
      // request cannot be answered from the first one's cache (doc 17 §4).
      const id = await newOwner();
      await request(server()).get(`/owners/${id}`).expect(200);

      const em = getOrm().em.fork();
      // MikroORM v7's `EntityName<T>` no longer includes a bare string; `as any`
      // keeps this a name-only reference rather than importing the class.
      await em.nativeUpdate("Owner" as any, { id }, { name: "Changed underneath" });

      const refetched = await request(server()).get(`/owners/${id}`).expect(200);
      expect(refetched.body.name).toBe("Changed underneath");
    });
  });
}
