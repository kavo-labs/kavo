/**
 * `kavo-security-testkit` (#491): the shared security conformance suite.
 * Private and never published — see this directory's README. Its source may
 * import only `@kavo/core` and `vitest` (`.dependency-cruiser.cjs`,
 * `security-testkit-imports-core-and-vitest-only`); every driver lives in the
 * consuming package's own `tests/`.
 */
export type { SecurityDriver, SecurityInput, SecurityResult, SecuritySurface } from "./driver.js";
export { isUnsupported } from "./driver.js";
export {
  HIDDEN_TENANT,
  VAULT_CONFIG,
  Vault,
  vaultConfig,
  vaultMetadata,
  type VaultRow,
  type VaultSeed,
} from "./fixture.js";
export { MemoryVaultAdapter } from "./memory-adapter.js";
export { toProgrammaticQuery, type ProgrammaticQuery } from "./programmatic-query.js";
export { engineDriver, type EngineOwner } from "./engine-driver.js";
export { defineSecuritySuite, type SecurityCaseId, type SecuritySuiteOptions } from "./suite.js";
