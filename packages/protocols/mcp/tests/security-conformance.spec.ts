import { ERROR_CATALOG, createKavo, type CatalogedErrorCode } from "@kavo/core";
import { crudTools, type KavoMcpToolBinding } from "@kavo/mcp";
import type { SecurityDriver, SecurityInput, SecurityResult } from "kavo-security-testkit";
import {
  MemoryVaultAdapter,
  VAULT_CONFIG,
  Vault,
  defineSecuritySuite,
  toProgrammaticQuery,
  vaultMetadata,
} from "kavo-security-testkit";

/**
 * The shared security conformance suite (#491) at the surface layer: every
 * attack is an MCP tool call through the toolset `crudTools` builds — the
 * arguments a model (or anyone who can reach the MCP route) controls.
 */
let adapter: MemoryVaultAdapter;
let tools: readonly KavoMcpToolBinding[];

const mcpDriver: SecurityDriver = {
  surface: "mcp",
  grammar: "programmatic",
  async call(operation: string, input: SecurityInput): Promise<SecurityResult> {
    const binding = tools.find((candidate) => candidate.tool.name === `vault.${operation}`);
    if (binding === undefined) {
      return { unsupported: `no tool for ${operation}` };
    }
    const translated = toProgrammaticQuery(input.query);
    if ("unsupported" in translated) {
      return translated;
    }
    const args: Record<string, unknown> = { ...(input.body as object | undefined) };
    if (input.id !== undefined) {
      args["id"] = Number(input.id);
    }
    if (operation === "findMany") {
      Object.assign(args, { filter: translated.filter, sort: translated.sort });
    }
    const result = await binding.handler(args);
    const text = (result.content[0] as { text: string }).text;
    if (result.isError === true) {
      // `${code}: ${detail}` — MCP's own convention for a domain failure.
      const code = text.slice(0, text.indexOf(":")) as CatalogedErrorCode;
      return { ok: false, status: ERROR_CATALOG[code]?.status ?? 500, code, body: text };
    }
    return { ok: true, status: 200, body: JSON.parse(text) };
  },
};

defineSecuritySuite({
  name: "@kavo/mcp (tool calls)",
  reset: async () => {
    adapter = new MemoryVaultAdapter();
    const service = createKavo().createCrud(Vault, VAULT_CONFIG as never, { adapter, metadata: vaultMetadata });
    tools = crudTools({ name: "Vault", service: service as never });
  },
  driver: () => mcpDriver,
  seed: async (rows) => adapter.seed(rows),
  read: async (id) => adapter.read(id),
  missingId: 999_999,
});
