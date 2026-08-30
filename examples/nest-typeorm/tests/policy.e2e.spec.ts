import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Column, DataSource, DeleteDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";
import { Controller, UseGuards, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { KavoAppContext, PolicyArgs } from "@kavo/core";
import { Kavo, KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/typeorm";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";
import { hasPermission, hasRole, isAuthenticated, isOwner } from "./support/policy.js";

/**
 * `policy` (ADR-0037) driven over real HTTP against a real SQLite database
 * — closing the gap `packages/core/tests/policy.spec.ts` leaves open, since
 * that file only ever exercises the engine against fake in-memory adapters.
 * Two things specifically only a real `@kavo/typeorm` adapter can confirm:
 *
 * - the policy stage's pre-fetch (`KavoEngine.policyPrefetchQuery`) really
 *   asks for soft-deleted rows on `restoreOne`/`purgeOne` (`withDeleted:
 *   true`), against `TypeOrmRepositoryAdapter.findOneById`'s real
 *   `query?.withDeleted ?? false` default — not a fixture that might get
 *   that default wrong in either direction;
 * - a denial actually reaches the client as a 403 problem-details document
 *   with `KAVO_FORBIDDEN`, through the real `@kavo/nest` exception filter.
 *
 * Builds its own module rather than reusing `AppModule`, matching
 * `array-mutation-resource.e2e.spec.ts`'s own precedent: the reference app
 * is adopter-facing documentation and should not carry entities or a guard
 * that exist only for a test.
 */

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @Column("varchar")
  authorId!: string;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}

/**
 * Stands in for whatever an app's real auth guard does — reads
 * comma-separated `x-roles`/`x-permissions` and a bare `x-user` header into
 * the shape `./support/policy.js`'s `hasPermission`/`hasRole`/`isOwner`/
 * `isAuthenticated` read off `context.app`. Absent `x-user`,
 * `request.user` is left unset, so `KavoModule`'s `app` extractor yields
 * `{}` — the "nobody is signed in" case every policy test needs to deny.
 */
class HeaderAppContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const incoming = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const userId = incoming.headers["x-user"];
    if (userId === undefined) {
      return true;
    }
    incoming.user = {
      userId,
      roles: (incoming.headers["x-roles"] ?? "").split(",").filter(Boolean),
      permissions: (incoming.headers["x-permissions"] ?? "").split(",").filter(Boolean),
    };
    return true;
  }
}

@Kavo(Post, {
  softDelete: { strategy: "soft" },
  operations: {
    createOne: { policy: isAuthenticated<Post>() },
    updateOne: {
      policy: (args: PolicyArgs<Post>) =>
        hasRole<Post>("admin")(args) || (hasPermission<Post>("post:update")(args) && isOwner<Post>("authorId")(args)),
    },
    patchOne: true,
    deleteOne: { policy: hasPermission<Post>("post:delete") },
    findOne: { policy: isOwner<Post>("authorId") },
    findMany: true,
    restoreOne: { policy: isOwner<Post>("authorId") },
    purgeOne: { policy: isOwner<Post>("authorId") },
  },
} as never)
@Controller("posts")
@UseGuards(new HeaderAppContextGuard())
class PostController {}

let dataSource: DataSource;
let app: INestApplication;
let httpServer: SupertestTarget | undefined;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Post],
    synchronize: true,
  });
  await dataSource.initialize();

  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({
        infrastructure: createInfrastructure(dataSource),
        app: (request): KavoAppContext => (request.user as KavoAppContext | undefined) ?? {},
      }),
      KavoModule.forFeature([PostController]),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  httpServer = await listen(app);
});

afterAll(async () => {
  httpServer = undefined;
  if (app !== undefined) {
    await app.close();
  }
  if (dataSource !== undefined) {
    await dataSource.destroy();
  }
});

beforeEach(async () => {
  await dataSource.getRepository(Post).clear();
});

function server(): SupertestTarget {
  return boundServer(httpServer);
}

async function seed(authorId: string): Promise<number> {
  const row = await dataSource.getRepository(Post).save({ title: "Dune", authorId });
  return row.id;
}

const asUser = (userId: string, extra: { roles?: string; permissions?: string } = {}) => ({
  "x-user": userId,
  ...(extra.roles !== undefined && { "x-roles": extra.roles }),
  ...(extra.permissions !== undefined && { "x-permissions": extra.permissions }),
});

describe("policy over real HTTP + SQLite (ADR-0037)", () => {
  it("denies createOne for an anonymous caller (isAuthenticated())", async () => {
    const response = await request(server()).post("/posts").send({ title: "x", authorId: "u-1" }).expect(403);
    expect(response.body).toMatchObject({ code: "KAVO_FORBIDDEN", status: 403 });
  });

  it("allows createOne once an app context is attached", async () => {
    await request(server()).post("/posts").set(asUser("u-1")).send({ title: "x", authorId: "u-1" }).expect(201);
  });

  it("hasPermission(): deleteOne requires the named permission", async () => {
    const id = await seed("u-1");
    await request(server()).delete(`/posts/${id}`).set(asUser("u-1")).expect(403);
    await request(server())
      .delete(`/posts/${id}`)
      .set(asUser("u-1", { permissions: "post:delete" }))
      .expect(204);
  });

  it("admin-or-owning-updater: the owner with the permission may update", async () => {
    const id = await seed("u-1");
    const response = await request(server())
      .put(`/posts/${id}`)
      .set(asUser("u-1", { permissions: "post:update" }))
      .send({ title: "mine now" })
      .expect(200);
    expect(response.body).toMatchObject({ title: "mine now" });
  });

  it("admin-or-owning-updater: a non-owner with the permission is still denied", async () => {
    const id = await seed("u-1");
    await request(server())
      .put(`/posts/${id}`)
      .set(asUser("u-2", { permissions: "post:update" }))
      .send({ title: "not mine" })
      .expect(403);
  });

  it("admin-or-owning-updater: an admin bypasses ownership entirely", async () => {
    const id = await seed("u-1");
    await request(server())
      .put(`/posts/${id}`)
      .set(asUser("u-9", { roles: "admin" }))
      .send({ title: "admin edit" })
      .expect(200);
  });

  it("the row is unchanged after a denied updateOne — the pre-fetch runs before the write, not after", async () => {
    const id = await seed("u-1");
    await request(server())
      .put(`/posts/${id}`)
      .set(asUser("u-2", { permissions: "post:update" }))
      .send({ title: "should not stick" })
      .expect(403);
    const row = await dataSource.getRepository(Post).findOneBy({ id });
    expect(row?.title).toBe("Dune");
  });

  it("findOne: 404 for a missing row beats 403 — existence never leaks through the status code", async () => {
    await request(server()).get("/posts/999999").set(asUser("u-1")).expect(404);
  });

  it("findOne: 403 for a row that exists but isn't the caller's", async () => {
    const id = await seed("u-1");
    await request(server()).get(`/posts/${id}`).set(asUser("u-2")).expect(403);
    const own = await request(server()).get(`/posts/${id}`).set(asUser("u-1")).expect(200);
    expect(own.body).toMatchObject({ title: "Dune" });
  });

  it(
    "restoreOne: the pre-fetch sees the soft-deleted row through the real adapter's withDeleted:true, " +
      "instead of always 404ing",
    async () => {
      const id = await seed("u-1");
      await request(server())
        .delete(`/posts/${id}`)
        .set(asUser("u-1", { permissions: "post:delete" }))
        .expect(204);

      // Soft-deleted: an ordinary findOne no longer sees it.
      await request(server()).get(`/posts/${id}`).set(asUser("u-1")).expect(404);

      // A non-owner is refused — the pre-fetch found the row and the
      // policy denied it, not "row not found."
      await request(server()).patch(`/posts/${id}/restore`).set(asUser("u-2")).expect(403);

      // The owner restores it successfully.
      const restored = await request(server()).patch(`/posts/${id}/restore`).set(asUser("u-1")).expect(200);
      expect(restored.body).toMatchObject({ title: "Dune" });

      const row = await dataSource.getRepository(Post).findOneBy({ id });
      expect(row?.deletedAt).toBeNull();
    },
  );

  it("purgeOne: same soft-deleted pre-fetch fix, against the real adapter", async () => {
    const id = await seed("u-1");
    await request(server())
      .delete(`/posts/${id}`)
      .set(asUser("u-1", { permissions: "post:delete" }))
      .expect(204);

    await request(server()).delete(`/posts/${id}/purge`).set(asUser("u-2")).expect(403);
    await request(server()).delete(`/posts/${id}/purge`).set(asUser("u-1")).expect(204);

    const row = await dataSource.getRepository(Post).findOneBy({ id });
    expect(row).toBeNull();
  });
});
