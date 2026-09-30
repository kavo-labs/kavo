import { createKavo } from "@kavo/core";
import { createKavoHandler, type KavoRouteHandlers } from "@kavo/next";
import type { SecurityDriver, SecurityInput, SecurityResult } from "kavo-security-testkit";
import { MemoryVaultAdapter, VAULT_CONFIG, Vault, defineSecuritySuite, vaultMetadata } from "kavo-security-testkit";

/**
 * The shared security conformance suite (#491) at the surface layer: every
 * attack goes through `createKavoHandler`'s App Router handlers as a real
 * `Request`, catch-all params and all.
 */
let adapter: MemoryVaultAdapter;
let handlers: KavoRouteHandlers;

const ROUTES: Readonly<Record<string, { method: keyof KavoRouteHandlers; byId: boolean }>> = {
  findMany: { method: "GET", byId: false },
  findOne: { method: "GET", byId: true },
  createOne: { method: "POST", byId: false },
  updateOne: { method: "PUT", byId: true },
  patchOne: { method: "PATCH", byId: true },
  deleteOne: { method: "DELETE", byId: true },
};

const nextDriver: SecurityDriver = {
  surface: "rest-next",
  grammar: "wire",
  async call(operation: string, input: SecurityInput): Promise<SecurityResult> {
    const route = ROUTES[operation];
    if (route === undefined) {
      return { unsupported: `no route for ${operation}` };
    }
    // Next.js hands the handler already-decoded catch-all segments.
    const segments = route.byId ? ["vaults", String(input.id)] : ["vaults"];
    const url = new URL(`http://localhost/api/${segments.map(encodeURIComponent).join("/")}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.append(key, value);
    }
    const response = await handlers[route.method](
      new Request(url, {
        method: route.method,
        headers: { "content-type": "application/json" },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }),
      { params: Promise.resolve({ kavo: segments }) },
    );
    const text = await response.text();
    const body = (text === "" ? null : JSON.parse(text)) as { code?: string } | null;
    return response.status < 400
      ? { ok: true, status: response.status, body }
      : { ok: false, status: response.status, code: body?.code, body };
  },
};

defineSecuritySuite({
  name: "@kavo/next (App Router handlers)",
  reset: async () => {
    adapter = new MemoryVaultAdapter();
    const service = createKavo().createCrud(Vault, VAULT_CONFIG as never, { adapter, metadata: vaultMetadata });
    handlers = createKavoHandler({ vaults: service as never });
  },
  driver: () => nextDriver,
  seed: async (rows) => adapter.seed(rows),
  read: async (id) => adapter.read(id),
  missingId: 999_999,
});
