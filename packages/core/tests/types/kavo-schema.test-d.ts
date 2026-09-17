import { expectTypeOf } from "vitest";
import type { KavoSchema, SchemaOutput, SchemaParseResult } from "@kavo/core";

/**
 * ADR-0055: `KavoSchema` is a structural contract, not a Zod wrapper — a
 * minimal stand-in class satisfies it with no library involved, and
 * `SchemaOutput` recovers its output type the way `z.infer` would.
 */

interface User {
  readonly id: number;
  readonly name: string;
}

class UserSchemaStub implements KavoSchema<User> {
  safeParse(input: unknown): SchemaParseResult<User> {
    return { success: true, data: input as User };
  }
}

const schema: KavoSchema<User> = new UserSchemaStub();

type Recovered = SchemaOutput<typeof schema>;
expectTypeOf<Recovered>().toEqualTypeOf<User>();

// A non-`KavoSchema` type recovers `never` — mirrors `z.infer` on a
// non-`ZodType`, rather than silently widening to `unknown`.
expectTypeOf<SchemaOutput<string>>().toEqualTypeOf<never>();

// `safeParse`'s discriminated result narrows `data`/`error` on `success`.
const result: SchemaParseResult<User> = schema.safeParse({ id: 1, name: "Ada" });
if (result.success) {
  expectTypeOf(result.data).toEqualTypeOf<User>();
} else {
  expectTypeOf(result.error.issues).toEqualTypeOf<
    readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]
  >();
}
