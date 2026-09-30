import { createKavo } from "@kavo/core";
import type { EngineOwner } from "kavo-security-testkit";
import {
  MemoryVaultAdapter,
  VAULT_CONFIG,
  Vault,
  defineSecuritySuite,
  engineDriver,
  vaultMetadata,
} from "kavo-security-testkit";

/**
 * The shared security conformance suite (#491) over the engine alone, with
 * the testkit's in-memory adapter: the baseline every ORM adapter's own run
 * of the same corpus is compared against. A case failing here is the
 * engine's; one failing only under an ORM is that adapter's.
 */
let adapter: MemoryVaultAdapter;
let service: EngineOwner;

defineSecuritySuite({
  name: "@kavo/core (engine, in-memory adapter)",
  reset: async () => {
    adapter = new MemoryVaultAdapter();
    service = createKavo().createCrud(Vault, VAULT_CONFIG as never, { adapter, metadata: vaultMetadata });
  },
  driver: () => engineDriver(service),
  seed: async (rows) => adapter.seed(rows),
  read: async (id) => adapter.read(id),
  missingId: 999_999,
});
