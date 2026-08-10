import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { DataSource } from "typeorm";
import { DATA_SOURCE } from "../src/database.module.js";
import { Address } from "../src/address/address.entity.js";

/**
 * The Pet example served by the real stack — generated Nest routes →
 * engine → TypeORM → a real database — with filtering, sorting, pagination,
 * DTO projections, layered config, and problem-details errors. The schema
 * models single-table inheritance (Cat/Dog over one `pet` table) and an
 * Owner relation; kavo serves plain CRUD on each concrete entity, plus
 * opt-in relation includes in both directions (asserted below).
 *
 * Parameterized by `getApp` so the same suite runs, unchanged, against both
 * the SQLite app (`app.e2e.spec.ts`) and the Testcontainers-provisioned
 * Postgres app (`app-postgres.e2e.spec.ts`) — one behavioral spec, two
 * drivers, no forked assertions.
 */
export function registerCrudE2eSuite(getApp: () => INestApplication): void {
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

  describe("Pet example app", () => {
    it("runs the full CRUD lifecycle over HTTP", async () => {
      const created = await request(server())
        .post("/cats")
        .send({ name: "First", age: 3, size: "small", indoor: true, livesLeft: 9 })
        .expect(201);
      // Response is the CatItemDto projection.
      expect(created.body).toMatchObject({
        name: "First",
        age: 3,
        size: "small",
        indoor: true,
        livesLeft: 9,
      });
      const id = created.body.id as number;

      const fetched = await request(server()).get(`/cats/${id}`).expect(200);
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

      // patchOne is disabled on CatController — no route generated.
      await request(server()).patch(`/cats/${id}`).send({ age: 5 }).expect(404);

      await request(server()).delete(`/cats/${id}`).expect(204);
      await request(server()).get(`/cats/${id}`).expect(404);
    });

    it("filters, sorts, and paginates through the query grammar", async () => {
      await seed();
      const response = await request(server())
        .get("/cats")
        .query("filter[age][gte]=30&sort=-age&limit=2&offset=1")
        .expect(200);

      // List responses use the leaner CatListDto projection.
      // Matches (age ≥ 30): Mittens 45, Shadow 41, Whiskers 36 — page starts at Shadow.
      expect(response.body.items.map((c: { name: string }) => c.name)).toEqual(["Shadow", "Whiskers"]);
      expect(response.body.items[0]).not.toHaveProperty("age");
      expect(response.body).toMatchObject({ limit: 2, offset: 1, total: 3 });
    });

    it("filters on the enum column", async () => {
      const response = await request(server()).get("/cats").query("filter[size][eq]=small&sort=name").expect(200);
      expect(response.body.items.map((c: { name: string }) => c.name)).toEqual(["Shadow", "Whiskers"]);
    });

    it("supports OR groups and IN sets from the wire", async () => {
      const response = await request(server())
        .get("/cats")
        .query("filter[or][0][name][eq]=Whiskers&filter[or][1][name][eq]=Tigger&sort=name")
        .expect(200);
      expect(response.body.items.map((c: { name: string }) => c.name)).toEqual(["Tigger", "Whiskers"]);
    });

    it("applies sparse fieldsets after DTO mapping", async () => {
      const response = await request(server()).get("/cats").query("fields=id,name&sort=name&limit=1").expect(200);
      expect(Object.keys(response.body.items[0])).toEqual(["id", "name"]);
    });

    it("restricts filterable, sortable, and selectable to an explicit list (issue #45)", async () => {
      // `indoor`/`livesLeft`/`createdAt` are still in every response
      // (`CatItemDto` includes them) but are not on the explicit
      // filterable/sortable/selectable lists in `cat.controller.ts`.
      const filtered = await request(server()).get("/cats").query("filter[indoor][eq]=true").expect(400);
      expect(filtered.body.errors).toEqual([
        expect.objectContaining({ field: "indoor", code: "KAVO_QUERY_INVALID_FIELD" }),
      ]);

      const sorted = await request(server()).get("/cats").query("sort=livesLeft").expect(400);
      expect(sorted.body.errors).toEqual([
        expect.objectContaining({ field: "livesLeft", code: "KAVO_QUERY_INVALID_FIELD" }),
      ]);

      const selected = await request(server()).get("/cats").query("fields=id,createdAt").expect(400);
      expect(selected.body.errors).toEqual([
        expect.objectContaining({ field: "createdAt", code: "KAVO_QUERY_INVALID_FIELD" }),
      ]);
    });

    it("honors the entity-scope pagination override (defaultLimit 10, max 50)", async () => {
      const defaulted = await request(server()).get("/cats").expect(200);
      expect(defaulted.body.limit).toBe(10);
      const clamped = await request(server()).get("/cats").query("limit=500").expect(200);
      expect(clamped.body.limit).toBe(50);
    });

    it("rejects bad queries with RFC 9457 problem details", async () => {
      const response = await request(server())
        .get("/cats")
        .query("filter[password][eq]=x&filter[age][eq]=abc")
        .expect(400)
        .expect("Content-Type", /application\/problem\+json/);
      expect(response.body).toMatchObject({
        status: 400,
        code: "KAVO_QUERY_INVALID",
        title: "Invalid query",
      });
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: "password", code: "KAVO_QUERY_INVALID_FIELD" }),
        expect.objectContaining({ field: "age", code: "KAVO_QUERY_INVALID_VALUE" }),
      ]);
    });

    it("rejects params that do not apply to this entity, never silently", async () => {
      // Cats are not soft-deletable (owners are), and `pets` is not a
      // relation of Cat — both are told, not ignored.
      const response = await request(server()).get("/cats").query("include=pets&withDeleted=true").expect(400);
      expect(response.body.errors.map((e: { code: string }) => e.code)).toEqual([
        "KAVO_QUERY_UNSUPPORTED_PARAM",
        "KAVO_QUERY_INVALID_FIELD",
      ]);
    });

    it("rejects a filter nested deeper than the default maxFilterDepth over a real query", async () => {
      // Built-in default is 3; four nested logical wrappers exceeds it
      // regardless of exactly where the count starts.
      const response = await request(server())
        .get("/cats")
        .query("filter[or][0][and][0][or][0][and][0][name][eq]=x")
        .expect(400);
      expect(response.body).toMatchObject({ code: "KAVO_QUERY_INVALID" });
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: "filter", code: "KAVO_QUERY_LIMIT_EXCEEDED" }),
      ]);
    });

    it("rejects an `in` value list past the default maxInValues over a real query", async () => {
      // Built-in default is 100; 101 values trips it.
      const query = Array.from({ length: 101 }, (_, i) => `filter[age][in][]=${i}`).join("&");
      const response = await request(server()).get("/cats").query(query).expect(400);
      expect(response.body).toMatchObject({ code: "KAVO_QUERY_INVALID" });
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: "age", code: "KAVO_QUERY_LIMIT_EXCEEDED" }),
      ]);
    });

    it("embeds relations both ways: a joined owner and batched pets", async () => {
      const owner = await request(server()).post("/owners").send({ name: "Rae", email: "rae@x.io" }).expect(201);
      const ownerId = owner.body.id as number;
      await request(server())
        .post("/cats")
        .send({ name: "Kit", age: 1, size: "small", indoor: true, livesLeft: 9, owner: ownerId })
        .expect(201);

      // To-one: joined into the list query, projected through OwnerItemDto
      // (so the owner's own `deletedAt` never leaks through the relation).
      const cats = await request(server()).get(`/cats?include=owner&filter[name][eq]=Kit`).expect(200);
      expect(cats.body.items[0]).toMatchObject({ name: "Kit", owner: { id: ownerId, name: "Rae" } });
      expect(cats.body.items[0].owner).not.toHaveProperty("deletedAt");

      // …and narrowed by a per-node fieldset.
      const narrowed = await request(server())
        .get(`/cats?include=owner&fields[owner]=id,name&filter[name][eq]=Kit`)
        .expect(200);
      expect(narrowed.body.items[0].owner).toEqual({ id: ownerId, name: "Rae" });

      // To-many: batched, on both the list and the detail route.
      const owners = await request(server()).get(`/owners?include=pets&filter[id][eq]=${ownerId}`).expect(200);
      expect(owners.body.items[0].pets).toEqual([expect.objectContaining({ name: "Kit" })]);
      const one = await request(server()).get(`/owners/${ownerId}?include=pets`).expect(200);
      expect(one.body.pets).toHaveLength(1);
    });

    it("embeds a two-level include (cat -> owner -> pets) within the default relation budget", async () => {
      // Built-in defaults (maxIncludeDepth: 2, maxIncludedNodes: 10) are
      // exactly enough for this real, two-level joined-then-batched tree —
      // never exercised together elsewhere in this suite. `owner.pets`
      // itself cannot be the second level here: `Pet` is the abstract STI
      // base `owner.pets` targets, and only the concrete `Cat`/`Dog`
      // subtypes carry a registered @Kavo config, so nothing below
      // `owner.pets` is includable (a real, separate limitation from the
      // relation budgets this test is actually about).
      const owner = await request(server()).post("/owners").send({ name: "Nia", email: "nia@x.io" }).expect(201);
      const ownerId = owner.body.id as number;
      const cat = await request(server())
        .post("/cats")
        .send({ name: "Momo", age: 2, size: "small", indoor: true, livesLeft: 9, owner: ownerId })
        .expect(201);

      const response = await request(server()).get(`/cats/${cat.body.id}?include=owner.pets`).expect(200);
      expect(response.body.owner).toMatchObject({
        name: "Nia",
        pets: [expect.objectContaining({ name: "Momo" })],
      });
    });

    it("keeps a relation out of the response until it is included", async () => {
      const owner = await request(server()).post("/owners").send({ name: "Ivo", email: "ivo@x.io" }).expect(201);
      // OwnerItemDto declares `pets`, but the shape is documentation — the
      // include decides the load.
      expect(owner.body).not.toHaveProperty("pets");
    });

    it("documents include and its per-relation fieldsets in the OpenAPI schema", () => {
      const document = SwaggerModule.createDocument(getApp(), new DocumentBuilder().build());
      const params = (document.paths["/cats"]?.get?.parameters ?? []) as { name: string; description?: string }[];
      expect(params.find((param) => param.name === "include")?.description).toContain("Includable: owner");
      expect(params.map((param) => param.name)).toContain("fields[owner]");
    });

    it("soft-deletes, restores, and purges owners", async () => {
      const created = await request(server()).post("/owners").send({ name: "Rose", email: "rose@x.io" }).expect(201);
      const id = created.body.id as number;

      await request(server()).delete(`/owners/${id}`).expect(204);
      await request(server()).get(`/owners/${id}`).expect(404);
      const withDeleted = await request(server())
        .get("/owners")
        .query(`withDeleted=true&filter[id][eq]=${id}`)
        .expect(200);
      expect(withDeleted.body.items).toHaveLength(1);

      // A second delete is a state conflict, not a 404.
      await request(server())
        .delete(`/owners/${id}`)
        .expect(409)
        .expect("Content-Type", /application\/problem\+json/);

      const restored = await request(server()).patch(`/owners/${id}/restore`).expect(200);
      expect(restored.body).toMatchObject({ id, name: "Rose" });
      await request(server()).get(`/owners/${id}`).expect(200);

      // Purge takes a soft-deleted row only.
      await request(server()).delete(`/owners/${id}/purge`).expect(409);
      await request(server()).delete(`/owners/${id}`).expect(204);
      await request(server()).delete(`/owners/${id}/purge`).expect(204);
      await request(server()).patch(`/owners/${id}/restore`).expect(404);
    });

    it("keeps deletedAt out of the filterable, sortable, and selectable allowlists (issue #45)", async () => {
      // `deletedAt` is soft-delete plumbing, not client-queryable data —
      // Owner's `@Kavo` config excludes it explicitly via `{ exclude }`.
      const filtered = await request(server()).get("/owners").query("filter[deletedAt][eq]=x").expect(400);
      expect(filtered.body.errors).toEqual([
        expect.objectContaining({ field: "deletedAt", code: "KAVO_QUERY_INVALID_FIELD" }),
      ]);

      const sorted = await request(server()).get("/owners").query("sort=deletedAt").expect(400);
      expect(sorted.body.errors).toEqual([
        expect.objectContaining({ field: "deletedAt", code: "KAVO_QUERY_INVALID_FIELD" }),
      ]);

      const selected = await request(server()).get("/owners").query("fields=id,deletedAt").expect(400);
      expect(selected.body.errors).toEqual([
        expect.objectContaining({ field: "deletedAt", code: "KAVO_QUERY_INVALID_FIELD" }),
      ]);
    });

    it("leaves hard-delete entities without restore or purge routes", async () => {
      const cat = await request(server())
        .post("/cats")
        .send({ name: "Ghost", age: 1, indoor: true, livesLeft: 9 })
        .expect(201);
      await request(server()).patch(`/cats/${cat.body.id}/restore`).expect(404);
      await request(server()).delete(`/cats/${cat.body.id}/purge`).expect(404);
    });

    it("maps unique violations to 409 conflict problem details", async () => {
      await request(server()).post("/owners").send({ name: "Ada", email: "ada@x.io" }).expect(201);
      await request(server())
        .post("/owners")
        .send({ name: "Duplicate", email: "ada@x.io" })
        .expect(409)
        .expect("Content-Type", /application\/problem\+json/);
    });

    it("runs the full CRUD lifecycle over HTTP for addresses", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Main St", city: "Springfield", postalCode: "00001" })
        .expect(201);
      expect(created.body).toMatchObject({ street: "1 Main St", city: "Springfield", postalCode: "00001" });
      const id = created.body.id as number;

      await request(server()).get(`/addresses/${id}`).expect(200);
      await request(server())
        .put(`/addresses/${id}`)
        .send({ street: "2 Main St", city: "Shelbyville", postalCode: "00002" })
        .expect(200);
      await request(server()).delete(`/addresses/${id}`).expect(204);
      await request(server()).get(`/addresses/${id}`).expect(404);
    });

    it("associates an owner with an address by id on create, and embeds it via include (one-to-one join)", async () => {
      const address = await request(server())
        .post("/addresses")
        .send({ street: "10 Elm St", city: "Ogdenville", postalCode: "10001" })
        .expect(201);
      const addressId = address.body.id as number;

      const owner = await request(server())
        .post("/owners")
        .send({ name: "Nadia", email: "nadia@x.io", address: addressId })
        .expect(201);
      const ownerId = owner.body.id as number;

      // Plain read never embeds it — the include decides the load.
      const plain = await request(server()).get(`/owners/${ownerId}`).expect(200);
      expect(plain.body).not.toHaveProperty("address");

      const included = await request(server()).get(`/owners/${ownerId}?include=address`).expect(200);
      expect(included.body.address).toMatchObject({ id: addressId, street: "10 Elm St", city: "Ogdenville" });

      // …and narrowed by a per-node fieldset, same as the to-one `owner` edge on cats.
      const narrowed = await request(server())
        .get(`/owners/${ownerId}?include=address&fields[address]=street,city`)
        .expect(200);
      expect(narrowed.body.address).toEqual({ street: "10 Elm St", city: "Ogdenville" });
    });

    it("associates, disassociates, and round-trips a null address on owners", async () => {
      const noAddress = await request(server()).post("/owners").send({ name: "Otis", email: "otis@x.io" }).expect(201);
      const id = noAddress.body.id as number;
      const included = await request(server()).get(`/owners/${id}?include=address`).expect(200);
      expect(included.body.address).toBeNull();

      const address = await request(server())
        .post("/addresses")
        .send({ street: "5 Oak Ave", city: "Capital City", postalCode: "20002" })
        .expect(201);
      await request(server())
        .put(`/owners/${id}`)
        .send({ name: "Otis", email: "otis@x.io", address: address.body.id })
        .expect(200);
      const attached = await request(server()).get(`/owners/${id}?include=address`).expect(200);
      expect(attached.body.address).toMatchObject({ id: address.body.id as number });

      await request(server())
        .put(`/owners/${id}`)
        .send({ name: "Otis", email: "otis@x.io", address: null })
        .expect(200);
      const detached = await request(server()).get(`/owners/${id}?include=address`).expect(200);
      expect(detached.body.address).toBeNull();
    });

    it("embeds addresses on the list route across a mix of populated and null owners", async () => {
      const address = await request(server())
        .post("/addresses")
        .send({ street: "9 Birch Rd", city: "North Haverbrook", postalCode: "30003" })
        .expect(201);
      const withAddress = await request(server())
        .post("/owners")
        .send({ name: "Priya", email: "priya@x.io", address: address.body.id })
        .expect(201);
      const withoutAddress = await request(server())
        .post("/owners")
        .send({ name: "Quinn", email: "quinn@x.io" })
        .expect(201);

      const list = await request(server())
        .get("/owners")
        .query(
          `include=address&filter[or][0][id][eq]=${withAddress.body.id}&filter[or][1][id][eq]=${withoutAddress.body.id}&sort=name`,
        )
        .expect(200);
      expect(list.body.items).toEqual([
        expect.objectContaining({ name: "Priya", address: expect.objectContaining({ id: address.body.id }) }),
        expect.objectContaining({ name: "Quinn", address: null }),
      ]);
    });

    it("does not fan out root rows when paginating a joined to-one include", async () => {
      for (const [name, email] of [
        ["Fanout1", "fanout1@x.io"],
        ["Fanout2", "fanout2@x.io"],
        ["Fanout3", "fanout3@x.io"],
      ] as const) {
        const address = await request(server())
          .post("/addresses")
          .send({ street: `${name} St`, city: "Fanoutville", postalCode: "40004" })
          .expect(201);
        await request(server()).post("/owners").send({ name, email, address: address.body.id }).expect(201);
      }

      const withoutInclude = await request(server())
        .get("/owners")
        .query("filter[email][like]=%25fanout%25")
        .expect(200);
      const withInclude = await request(server())
        .get("/owners")
        .query("include=address&filter[email][like]=%25fanout%25&limit=2")
        .expect(200);
      expect(withInclude.body.total).toBe(withoutInclude.body.total);
      expect(withInclude.body.items).toHaveLength(2);
    });

    it("maps a duplicate address association to a 409 conflict (unique join column)", async () => {
      const address = await request(server())
        .post("/addresses")
        .send({ street: "1 Shared Way", city: "Duplicity", postalCode: "50005" })
        .expect(201);
      await request(server())
        .post("/owners")
        .send({ name: "First", email: "first@x.io", address: address.body.id })
        .expect(201);
      const conflict = await request(server())
        .post("/owners")
        .send({ name: "Second", email: "second@x.io", address: address.body.id })
        .expect(409)
        .expect("Content-Type", /application\/problem\+json/);
      expect(conflict.body.code).toBe("KAVO_CONFLICT");
    });

    it("rejects associating a nonexistent address id as a conflict, not a silent drop", async () => {
      const created = await request(server())
        .post("/owners")
        .send({ name: "Rex", email: "rex@x.io", address: 999999 })
        .expect(409)
        .expect("Content-Type", /application\/problem\+json/);
      expect(created.body.code).toBe("KAVO_CONFLICT");

      const owner = await request(server()).post("/owners").send({ name: "Sam", email: "sam@x.io" }).expect(201);
      const updateConflict = await request(server())
        .put(`/owners/${owner.body.id}`)
        .send({ name: "Sam", email: "sam@x.io", address: 999999 })
        .expect(409)
        .expect("Content-Type", /application\/problem\+json/);
      expect(updateConflict.body.code).toBe("KAVO_CONFLICT");
    });

    it("clears the owning relation before deleting a referenced address (issue #21 deleteOne override)", async () => {
      // Address's `deleteOne` is overridden (issue #21) to detach the owner's
      // side of the join column first, rather than leaving the FK constraint
      // to refuse the delete outright.
      const address = await request(server())
        .post("/addresses")
        .send({ street: "1 Referenced Ln", city: "Bindingtown", postalCode: "60006" })
        .expect(201);
      const owner = await request(server())
        .post("/owners")
        .send({ name: "Tara", email: "tara@x.io", address: address.body.id })
        .expect(201);

      await request(server()).delete(`/addresses/${address.body.id}`).expect(204);
      await request(server()).get(`/addresses/${address.body.id}`).expect(404);

      const detached = await request(server()).get(`/owners/${owner.body.id}?include=address`).expect(200);
      expect(detached.body.address).toBeNull();
    });

    it("documents include=address and fields[address] in the OpenAPI schema", () => {
      const document = SwaggerModule.createDocument(getApp(), new DocumentBuilder().build());
      const params = (document.paths["/owners"]?.get?.parameters ?? []) as { name: string; description?: string }[];
      expect(params.find((param) => param.name === "include")?.description).toContain("address");
      expect(params.map((param) => param.name)).toContain("fields[address]");
    });

    it("round-trips the nullable startedAt date on owners", async () => {
      const withDate = await request(server())
        .post("/owners")
        .send({ name: "Grace", email: "grace@x.io", startedAt: "2020-01-15T00:00:00.000Z" })
        .expect(201);
      expect(new Date(withDate.body.startedAt as string).toISOString()).toBe("2020-01-15T00:00:00.000Z");

      const withoutDate = await request(server())
        .post("/owners")
        .send({ name: "Alan", email: "alan@x.io" })
        .expect(201);
      expect(withoutDate.body.startedAt).toBeNull();
    });

    it("ignores client-sent generated columns", async () => {
      const created = await request(server())
        .post("/cats")
        .send({ id: 4242, name: "Gen", age: 1, indoor: true, livesLeft: 9 })
        .expect(201);
      expect(created.body.id).not.toBe(4242);
    });

    it("scopes each route to its subtype via the discriminator", async () => {
      const cat = await request(server())
        .post("/cats")
        .send({ name: "Felix", age: 2, indoor: true, livesLeft: 9 })
        .expect(201);
      const dog = await request(server())
        .post("/dogs")
        .send({ name: "Rex", age: 4, breed: "Labrador", goodBoy: true })
        .expect(201);

      const cats = await request(server()).get("/cats").query("limit=50").expect(200);
      const catNames = cats.body.items.map((c: { name: string }) => c.name);
      expect(catNames).toContain("Felix");
      expect(catNames).not.toContain("Rex");

      const dogs = await request(server()).get("/dogs").query("limit=50").expect(200);
      const dogNames = dogs.body.items.map((d: { name: string }) => d.name);
      expect(dogNames).toEqual(["Rex"]);

      // Each route reads back only its own subtype's row.
      await request(server()).get(`/cats/${cat.body.id}`).expect(200);
      await request(server()).get(`/dogs/${dog.body.id}`).expect(200);
    });

    it("falls back to entity-derived DTOs on /dogs, which declares no `dto` block", async () => {
      const created = await request(server())
        .post("/dogs")
        .send({ name: "Fido", age: 3, breed: "Beagle", goodBoy: true, id: 4242 })
        .expect(201);
      // Entity-derived write projection: every non-generated column is
      // writable, so no hand-picked `create` DTO is trimming the request —
      // but the generated `id` primary column still can't be client-set.
      expect(created.body).toMatchObject({ name: "Fido", age: 3, breed: "Beagle", goodBoy: true });
      expect(created.body.id).not.toBe(4242);

      // Entity-derived read projection: every scalar column serializes,
      // unlike the curated `CatItemDto`/`CatListDto` pair — there is no
      // leaner `list` shape distinct from `item` once both fall back.
      expect(created.body).toHaveProperty("createdAt");
      const list = await request(server()).get("/dogs").query("limit=50").expect(200);
      const fido = list.body.items.find((item: { id: number }) => item.id === created.body.id);
      expect(fido).toHaveProperty("createdAt");
      expect(fido).toMatchObject({ name: "Fido", breed: "Beagle" });
    });

    it("associates tags by id and embeds them via a batched many-to-many include", async () => {
      const tagA = await request(server()).post("/tags").send({ name: "playful" }).expect(201);
      const tagB = await request(server()).post("/tags").send({ name: "lazy" }).expect(201);
      const tagIdA = tagA.body.id as number;
      const tagIdB = tagB.body.id as number;

      const cat = await request(server())
        .post("/cats")
        .send({ name: "Tagged", age: 2, size: "small", indoor: true, livesLeft: 9, tags: [tagIdA, tagIdB] })
        .expect(201);
      const catId = cat.body.id as number;

      // Not included until asked: the create response is the plain
      // CatItemDto projection, and tags stay off a plain GET too.
      expect(cat.body).not.toHaveProperty("tags");
      const plain = await request(server()).get(`/cats/${catId}`).expect(200);
      expect(plain.body).not.toHaveProperty("tags");

      const fetched = await request(server()).get(`/cats/${catId}?include=tags`).expect(200);
      expect(fetched.body.tags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: tagIdA, name: "playful" }),
          expect.objectContaining({ id: tagIdB, name: "lazy" }),
        ]),
      );
      expect(fetched.body.tags).toHaveLength(2);

      // Narrowed by a per-node fieldset, same as the to-one `owner` edge.
      const narrowed = await request(server()).get(`/cats/${catId}?include=tags&fields[tags]=id`).expect(200);
      expect(narrowed.body.tags).toEqual(expect.arrayContaining([{ id: tagIdA }, { id: tagIdB }]));

      // Replacing the tag set on update: this is the case that would fail if
      // the join table needed the prior relation state preloaded before save.
      await request(server())
        .put(`/cats/${catId}`)
        .send({
          name: "Tagged",
          age: 2,
          size: "small",
          indoor: true,
          livesLeft: 9,
          tags: [tagIdB],
        })
        .expect(200);
      const afterUpdate = await request(server()).get(`/cats/${catId}?include=tags`).expect(200);
      expect(afterUpdate.body.tags).toEqual([expect.objectContaining({ id: tagIdB, name: "lazy" })]);

      // Clearing the set removes every association.
      await request(server())
        .put(`/cats/${catId}`)
        .send({
          name: "Tagged",
          age: 2,
          size: "small",
          indoor: true,
          livesLeft: 9,
          tags: [],
        })
        .expect(200);
      const cleared = await request(server()).get(`/cats/${catId}?include=tags`).expect(200);
      expect(cleared.body.tags).toEqual([]);
    });

    it("rejects associating a nonexistent tag id as a conflict, not a silent drop", async () => {
      // ADR-0014's association-by-id path has no existence check of its own —
      // an unknown id surfaces as the join table's own FK-constraint violation.
      const response = await request(server())
        .post("/cats")
        .send({ name: "BadTag", age: 1, size: "small", indoor: true, livesLeft: 9, tags: [999999] })
        .expect(409)
        .expect("Content-Type", /application\/problem\+json/);
      expect(response.body.code).toBe("KAVO_CONFLICT");
    });

    it("cleans up the join table when a still-referenced tag is deleted", async () => {
      const tag = await request(server()).post("/tags").send({ name: "temporary" }).expect(201);
      const tagId = tag.body.id as number;
      const cat = await request(server())
        .post("/cats")
        .send({ name: "Referencing", age: 1, size: "small", indoor: true, livesLeft: 9, tags: [tagId] })
        .expect(201);

      await request(server()).delete(`/tags/${tagId}`).expect(204);

      const afterDelete = await request(server()).get(`/cats/${cat.body.id}?include=tags`).expect(200);
      expect(afterDelete.body.tags).toEqual([]);
    });

    it("keeps include=tags an opt-in allowlist entry, not a free pass", async () => {
      // Dogs never declared `tags` includable — same allowlist rule as any
      // other relation.
      const response = await request(server()).get("/dogs").query("include=tags").expect(400);
      expect(response.body.errors.map((e: { code: string }) => e.code)).toEqual(["KAVO_QUERY_INVALID_FIELD"]);
    });

    it("counts and slices distinct roots under pagination even when a cat has several tags", async () => {
      const before = await request(server()).get("/cats").query("limit=1").expect(200);
      const totalBefore = before.body.total as number;

      const tags = [];
      for (const name of ["a", "b", "c"]) {
        tags.push((await request(server()).post("/tags").send({ name }).expect(201)).body.id as number);
      }
      const fanOut = await request(server())
        .post("/cats")
        .send({ name: "FanOut", age: 1, size: "small", indoor: true, livesLeft: 9, tags })
        .expect(201);
      const fanOutId = fanOut.body.id as number;

      // Sorted newest-first so the just-created fan-out cat is guaranteed to
      // land inside the requested page, not merely outside its window.
      const page = await request(server()).get("/cats").query("include=tags&sort=-id&limit=2&offset=0").expect(200);
      // Root count/slice is over distinct cats, never joined (cat × tag) rows —
      // a fan-out of 3 tags on one cat must not multiply `total` or the page,
      // and must not appear duplicated within the page either.
      expect(page.body.total).toBe(totalBefore + 1);
      expect(page.body.items).toHaveLength(2);
      const fanOutInPage = page.body.items.filter((item: { id: number }) => item.id === fanOutId);
      expect(fanOutInPage).toHaveLength(1);
      expect(fanOutInPage[0].tags).toHaveLength(3);

      const fanOutRow = (await request(server()).get(`/cats/${fanOutId}?include=tags`).expect(200)).body as {
        tags: unknown[];
      };
      expect(fanOutRow.tags).toHaveLength(3);
    });

    it("documents the size enum and the owner pets oneOf in the OpenAPI schema", () => {
      type Schema = {
        type?: string;
        properties?: Record<string, Schema>;
        items?: Schema;
        enum?: readonly string[];
        example?: string;
        oneOf?: readonly { title?: string }[];
      };
      const document = SwaggerModule.createDocument(
        getApp(),
        new DocumentBuilder().setTitle("t").setVersion("0").build(),
      );

      const catBody = (
        document.paths["/cats"] as { post?: { requestBody?: { content?: Record<string, { schema?: Schema }> } } }
      )?.post?.requestBody?.content?.["application/json"]?.schema;
      expect(catBody?.properties?.size).toEqual({
        type: "string",
        enum: ["small", "medium", "large"],
        example: "medium",
      });

      const ownerItem = (
        document.paths["/owners/{id}"] as Record<
          string,
          { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }
        >
      )?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
      const pets = ownerItem?.properties?.pets;
      expect(pets?.type).toBe("array");
      expect(pets?.items?.oneOf?.map((variant) => variant.title)).toEqual(["CatItemDto", "DogItemDto"]);
    });
  });

  /**
   * `Address` overrides all five singular standard operations through
   * `@Override`'d controller methods (issue #21/#23), and adds two fully
   * custom, registry-independent routes (issue #26).
   */
  describe("Address operation overrides (issue #21)", () => {
    it("normalizes postalCode on create", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: " 10001 " })
        .expect(201);
      expect(created.body.postalCode).toBe("10001");
    });

    it("rejects a malformed postalCode on create as a problem-details 400", async () => {
      const response = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "abc" })
        .expect(400)
        .expect("Content-Type", /application\/problem\+json/);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: "postalCode", code: "KAVO_QUERY_INVALID_VALUE" }),
      ]);
    });

    it("rejects a malformed postalCode on update, leaving the row unchanged", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      await request(server())
        .put(`/addresses/${id}`)
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "bad" })
        .expect(400)
        .expect("Content-Type", /application\/problem\+json/);

      const unchanged = await request(server()).get(`/addresses/${id}`).expect(200);
      expect(unchanged.body.postalCode).toBe("10001");
    });

    it("is partial-field aware on patch: omitting postalCode never triggers validation", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      const patched = await request(server()).patch(`/addresses/${id}`).send({ city: "Shelbyville" }).expect(200);
      expect(patched.body).toMatchObject({ city: "Shelbyville", postalCode: "10001" });
    });

    it("rejects a malformed postalCode on patch too, when the field is present", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      await request(server())
        .patch(`/addresses/${id}`)
        .send({ postalCode: "nope" })
        .expect(400)
        .expect("Content-Type", /application\/problem\+json/);
    });

    it("augments findOne with a derived formattedAddress field", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      const fetched = await request(server()).get(`/addresses/${id}`).expect(200);
      expect(fetched.body.formattedAddress).toBe("1 Elm St, Springfield 10001");
    });

    it("wires GET /addresses/:id query params through the same normalization a generated route would", async () => {
      // Regression: an @Override'd findOne's query param is auto-wired into
      // WireQuery the same way a generated route's is (issue #25) — the
      // override itself does no manual flattenQuery/WireQuery wrapping.
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      const narrowed = await request(server())
        .get(`/addresses/${id}`)
        .query("fields=street,city,postalCode")
        .expect(200);
      expect(Object.keys(narrowed.body).sort()).toEqual(["city", "formattedAddress", "postalCode", "street"]);
    });

    it("corrects a dirty postalCode via the custom route", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      // Every write path through the API already normalizes on the way in
      // (createOne/updateOne/patchOne), so the only way to observe the
      // custom route's own normalization actually doing something is to
      // seed a dirty value directly, bypassing the controller entirely.
      const dataSource = getApp().get<DataSource>(DATA_SOURCE);
      await dataSource.getRepository(Address).update(id, { postalCode: " 20002 " });

      const response = await request(server()).post(`/addresses/${id}/normalize-postal-code`).expect(201);
      expect(response.body.postalCode).toBe("20002");

      const fetched = await request(server()).get(`/addresses/${id}`).expect(200);
      expect(fetched.body.postalCode).toBe("20002");
    });

    it("404s when normalizing a nonexistent address", async () => {
      const response = await request(server())
        .post("/addresses/999999/normalize-postal-code")
        .expect(404)
        .expect("Content-Type", /application\/problem\+json/);
      expect(response.body.code).toBe("KAVO_NOT_FOUND");
    });

    it("validates a clean postalCode via the fully custom route, without mutating it", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      const response = await request(server()).get(`/addresses/${id}/validate-postal-code`).expect(200);
      expect(response.body).toEqual({ valid: true });
    });

    it("reports an invalid postalCode via the fully custom route, without correcting it", async () => {
      const created = await request(server())
        .post("/addresses")
        .send({ street: "1 Elm St", city: "Springfield", postalCode: "10001" })
        .expect(201);
      const id = created.body.id as number;

      // As with the normalize-postal-code test above, every write path
      // already normalizes on the way in, so a dirty value has to be seeded
      // directly to observe this read-only route doing anything.
      const dataSource = getApp().get<DataSource>(DATA_SOURCE);
      await dataSource.getRepository(Address).update(id, { postalCode: "bad" });

      const response = await request(server()).get(`/addresses/${id}/validate-postal-code`).expect(200);
      expect(response.body).toEqual({ valid: false });

      const fetched = await request(server()).get(`/addresses/${id}`).expect(200);
      expect(fetched.body.postalCode).toBe("bad");
    });

    it("404s when validating a nonexistent address", async () => {
      const response = await request(server())
        .get("/addresses/999999/validate-postal-code")
        .expect(404)
        .expect("Content-Type", /application\/problem\+json/);
      expect(response.body.code).toBe("KAVO_NOT_FOUND");
    });
  });
}
