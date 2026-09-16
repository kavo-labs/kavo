import { describe, expect, it } from "vitest";
import type { EntityMetadata, KavoEngine, ResolvedEntityConfig } from "@kavo/core";
import { buildEntitySchemas } from "../src/openapi/entity-schemas.js";

/**
 * `writeSchema`'s id-exclusion (entity-schemas.ts) has two ways to keep the
 * id field out of Create/Update/Patch: `field.generated` (the common case,
 * covered by the Todo fixture's own auto-increment id everywhere else in
 * this suite) and — separately — a non-generated but still single-key
 * `idField` name match, which only a natural (caller-assigned) primary key
 * exercises. This fixture is that second case.
 */
class NaturallyKeyedThing {
  code!: string;
  label!: string;
}

const metadata: EntityMetadata<NaturallyKeyedThing> = {
  entity: NaturallyKeyedThing,
  name: "NaturallyKeyedThing",
  idField: "code",
  fields: [
    { name: "code", kind: "string", nullable: false, generated: false },
    { name: "label", kind: "string", nullable: false, generated: false },
  ],
  relations: [],
};

const config = {
  settings: { pagination: { strategy: "offset" } },
  include: { fields: [] },
  sort: { fields: [] },
  filter: { fields: [] },
  select: { fields: [] },
  search: false,
} as unknown as ResolvedEntityConfig<NaturallyKeyedThing>;

const engine = { metadata, config } as unknown as KavoEngine<object>;

describe("buildEntitySchemas — natural (non-generated) primary key", () => {
  it("still excludes the id field from Create, matching the generated-id case", () => {
    const schemas = buildEntitySchemas("NaturallyKeyedThing", engine);
    const create = schemas.NaturallyKeyedThingCreate as { properties: Record<string, unknown> };
    expect(create.properties).not.toHaveProperty("code");
    expect(create.properties).toHaveProperty("label");
  });
});
