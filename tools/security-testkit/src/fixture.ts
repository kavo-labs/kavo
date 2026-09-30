import type { EntityConfig, EntityMetadata } from "@kavo/core";

/**
 * The one entity every driver runs the corpus against. Each consumer
 * declares it in its own ORM's terms (a TypeORM class, a MikroORM class, a
 * Prisma model, a Mongoose schema) with exactly these columns, and hands it
 * {@link VAULT_CONFIG} unchanged:
 *
 * - `id` — generated numeric primary key (Mongoose: its own `_id`, see
 *   `SecuritySuiteOptions.idIsGenerated`).
 * - `name` — filterable, sortable, selectable, searchable string.
 * - `tenant` — filterable, selectable string; `filter.apply` hides every
 *   row whose tenant is {@link HIDDEN_TENANT}.
 * - `rank` — filterable, sortable, selectable integer (default `0`), the
 *   numeric column the coercion cases use on every adapter, id format aside.
 * - `apiKey` — nullable string, a stand-in for any credential column: in no
 *   allowlist and not writable, so no request may read, match, order by,
 *   or set it.
 */
export interface VaultRow {
  readonly id: number | string;
  readonly name: string;
  readonly tenant: string;
  readonly rank?: number;
  readonly apiKey: string | null;
}

export type VaultSeed = Omit<VaultRow, "id">;

/** The tenant `filter.apply` scopes out on every read. */
export const HIDDEN_TENANT = "hidden";

/**
 * The configuration every driver's entity runs under — {@link VAULT_CONFIG},
 * or `vaultConfig("_id")` for an ORM whose primary key has another name
 * (Mongoose). The policy denies `deleteOne` outright, so the suite can check
 * a denial has the same shape on every surface. `filter.apply` uses no app
 * context: GraphQL and MCP carry none today, so a scope that depended on it
 * could not be compared across surfaces.
 */
export function vaultConfig(idField = "id"): EntityConfig<object> {
  return {
    filter: {
      fields: [idField, "name", "tenant", "rank"],
      apply: () => ({ kind: "condition", field: "tenant", operator: "NE", value: HIDDEN_TENANT }),
    },
    sort: { fields: [idField, "name", "rank"] },
    select: { fields: [idField, "name", "tenant", "rank"] },
    search: { fields: ["name"] },
    schema: {
      input: { create: { fields: ["name", "tenant", "rank"] }, update: { fields: ["name", "tenant", "rank"] } },
    },
    policy: ({ operation }: { operation: string }) => operation !== "deleteOne",
  } as unknown as EntityConfig<object>;
}

export const VAULT_CONFIG: EntityConfig<object> = vaultConfig();

/** A plain class the in-memory adapter and core-only drivers use as the entity identity. */
export class Vault {
  id = 0;
  name = "";
  tenant = "";
  rank = 0;
  apiKey: string | null = null;
}

export const vaultMetadata: EntityMetadata<Vault> = {
  entity: Vault,
  name: "Vault",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
    { name: "tenant", kind: "string", nullable: false, generated: false },
    { name: "rank", kind: "number", nullable: false, generated: false },
    { name: "apiKey", kind: "string", nullable: true, generated: false },
  ],
  relations: [],
};
