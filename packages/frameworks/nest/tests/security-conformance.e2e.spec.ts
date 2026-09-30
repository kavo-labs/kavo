import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import request from "supertest";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ClassRef, EntityMetadata, KavoInfrastructure, RepositoryAdapter } from "@kavo/core";
import { Kavo, KavoModule } from "@kavo/nest";
import type { SecurityDriver, SecurityInput, SecurityResult } from "kavo-security-testkit";
import { MemoryVaultAdapter, VAULT_CONFIG, Vault, defineSecuritySuite, vaultMetadata } from "kavo-security-testkit";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * The shared security conformance suite (#491) at the surface layer: every
 * attack goes over real HTTP through a `@Kavo`-generated controller, so a
 * surface-level gap (a route that skips the engine, a pipe that rewrites a
 * body, an error filter that leaks) fails here even where the engine-level
 * run of the same corpus passes.
 */
@Kavo(Vault, VAULT_CONFIG as never)
@Controller("vaults")
class VaultController {}

let adapter: MemoryVaultAdapter;
let app: INestApplication;
let server: SupertestTarget | undefined;

const ROUTES: Readonly<Record<string, { method: "get" | "post" | "put" | "patch" | "delete"; byId: boolean }>> = {
  findMany: { method: "get", byId: false },
  findOne: { method: "get", byId: true },
  createOne: { method: "post", byId: false },
  updateOne: { method: "put", byId: true },
  patchOne: { method: "patch", byId: true },
  deleteOne: { method: "delete", byId: true },
};

const restDriver: SecurityDriver = {
  surface: "rest-nest",
  grammar: "wire",
  async call(operation: string, input: SecurityInput): Promise<SecurityResult> {
    const route = ROUTES[operation];
    if (route === undefined) {
      return { unsupported: `no generated route for ${operation}` };
    }
    const path = route.byId ? `/vaults/${encodeURIComponent(String(input.id))}` : "/vaults";
    let pending = request(boundServer(server))
      [route.method](path)
      .query(input.query ?? {});
    if (input.body !== undefined) {
      pending = pending.send(input.body as object);
    }
    const response = await pending;
    const body = response.body as { code?: string };
    return response.status < 400
      ? { ok: true, status: response.status, body }
      : { ok: false, status: response.status, code: body.code, body };
  },
};

function infrastructure(): KavoInfrastructure {
  return {
    metadataFor<Entity extends object>(entity: ClassRef<Entity>) {
      if ((entity as ClassRef) !== Vault) {
        throw new Error(`no metadata for ${entity.name}`);
      }
      return vaultMetadata as unknown as EntityMetadata<Entity>;
    },
    adapterFor<Entity extends object>() {
      return adapter as unknown as RepositoryAdapter<Entity>;
    },
  };
}

beforeAll(async () => {
  adapter = new MemoryVaultAdapter();
  const moduleRef = await Test.createTestingModule({
    imports: [KavoModule.forRoot({ infrastructure: infrastructure() }), KavoModule.forFeature([VaultController])],
  }).compile();
  app = moduleRef.createNestApplication();
  server = await listen(app);
});

afterAll(async () => {
  await app.close();
});

defineSecuritySuite({
  name: "@kavo/nest (REST over HTTP)",
  reset: async () => {
    adapter.rows.splice(0);
  },
  driver: () => restDriver,
  seed: async (rows) => adapter.seed(rows),
  read: async (id) => adapter.read(id),
  missingId: 999_999,
});
