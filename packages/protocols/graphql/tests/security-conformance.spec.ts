import { createKavo, KavoException, toProblemDetails } from "@kavo/core";
import {
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  graphql,
  type GraphQLSchema,
} from "graphql";
import { createKavoGraphQLSchema } from "@kavo/graphql";
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
 * attack is a GraphQL document run against the schema `@kavo/graphql` builds.
 * The input types deliberately declare `id` and `apiKey`, the fields the
 * engine must strip, so a stripped write proves the engine did it — not the
 * GraphQL type.
 */
const VaultType = new GraphQLObjectType({
  name: "Vault",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLInt) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    tenant: { type: new GraphQLNonNull(GraphQLString) },
    rank: { type: GraphQLInt },
  },
});

const hostileInputFields = {
  id: { type: GraphQLInt },
  name: { type: GraphQLString },
  tenant: { type: GraphQLString },
  rank: { type: GraphQLInt },
  apiKey: { type: GraphQLString },
};
const CreateVaultInput = new GraphQLInputObjectType({ name: "CreateVaultInput", fields: hostileInputFields });
const PatchVaultInput = new GraphQLInputObjectType({ name: "PatchVaultInput", fields: hostileInputFields });

let adapter: MemoryVaultAdapter;
let schema: GraphQLSchema;

const ITEM = "id name tenant rank";
const DOCUMENTS: Readonly<Record<string, string>> = {
  findMany: `query($filter: JSON, $sort: [String!]) { vaults(filter: $filter, sort: $sort) { items { ${ITEM} } total } }`,
  findOne: `query($id: Int!) { vault(id: $id) { ${ITEM} } }`,
  createOne: `mutation($input: CreateVaultInput!) { createVault(input: $input) { ${ITEM} } }`,
  patchOne: `mutation($id: Int!, $input: PatchVaultInput!) { patchVault(id: $id, input: $input) { ${ITEM} } }`,
  deleteOne: `mutation($id: Int!) { deleteVault(id: $id) }`,
};

const graphqlDriver: SecurityDriver = {
  surface: "graphql",
  grammar: "programmatic",
  async call(operation: string, input: SecurityInput): Promise<SecurityResult> {
    const source = DOCUMENTS[operation];
    if (source === undefined) {
      return { unsupported: `no GraphQL field for ${operation}` };
    }
    const translated = toProgrammaticQuery(input.query);
    if ("unsupported" in translated) {
      return translated;
    }
    const result = await graphql({
      schema,
      source,
      variableValues: {
        ...(input.id === undefined ? {} : { id: Number(input.id) }),
        ...(input.body === undefined ? {} : { input: input.body }),
        filter: translated.filter,
        sort: translated.sort,
      },
    });
    const error = result.errors?.[0];
    if (error !== undefined) {
      const cause = error.originalError;
      // What a client sees is the serialized `errors` array; the status and
      // code come from the Kavo exception behind it, when there is one.
      const body = JSON.parse(JSON.stringify(result.errors));
      return cause instanceof KavoException
        ? { ok: false, status: toProblemDetails(cause).status, code: cause.code, body }
        : { ok: false, status: 400, body };
    }
    const data = Object.values(result.data ?? {})[0];
    return { ok: true, status: 200, body: data };
  },
};

defineSecuritySuite({
  name: "@kavo/graphql (schema)",
  reset: async () => {
    adapter = new MemoryVaultAdapter();
    const service = createKavo().createCrud(Vault, VAULT_CONFIG as never, { adapter, metadata: vaultMetadata });
    schema = createKavoGraphQLSchema({
      name: "Vault",
      service: service as never,
      itemType: VaultType,
      createInputType: CreateVaultInput,
      patchInputType: PatchVaultInput,
      deleteOne: true,
    });
  },
  driver: () => graphqlDriver,
  seed: async (rows) => adapter.seed(rows),
  read: async (id) => adapter.read(id),
  missingId: 999_999,
});
