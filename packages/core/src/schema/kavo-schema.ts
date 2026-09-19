/**
 * ADR-0055: the structural contract `schema` config is typed against.
 * `@kavo/core` has zero runtime dependencies (ADR-0005) — it cannot
 * `import` `zod` — so this is a minimal shape a validation library's
 * result already satisfies rather than a wrapper around one. A `ZodType<T>`
 * satisfies {@link KavoSchema} natively: `.safeParse` already returns
 * exactly {@link SchemaParseResult}, and `ZodError.issues` already carries
 * `path`/`message`. Any other library whose result can be adapted to this
 * shape works the same way; nothing here assumes Zod specifically.
 */

/** One field-level parse failure, before it is joined into a `QueryIssueDto`. */
export interface SchemaIssue {
  /**
   * The failing field's path, as a property-key sequence (e.g.
   * `["address", "zip"]` for a nested field) — joined with `.` into
   * {@link QueryIssueDto.field}, the same dot-joining a `class-validator`
   * `ValidationPipe`'s nested `children` need for the same purpose.
   */
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** The discriminated result `KavoSchema.safeParse` returns. */
export type SchemaParseResult<Output> =
  | { readonly success: true; readonly data: Output }
  | { readonly success: false; readonly error: { readonly issues: readonly SchemaIssue[] } };

/**
 * The structural contract a `schema.input.<slot>` / `schema.output.<slot>`
 * value must satisfy. Deliberately minimal — one required method, one result
 * shape — so it constrains nothing about the library that produced it.
 *
 * `toJSONSchema` is optional (issue #467): ADR-0055 makes `schema` the
 * source of truth for OpenAPI component generation too, but `safeParse`
 * alone gives `@kavo/nest`'s `registerKavoSchemas` nothing to introspect —
 * there is no field list to walk on an opaque validator. A schema that also
 * implements `toJSONSchema` (a thin wrapper calling e.g. Zod 4's
 * `z.toJSONSchema(schema)`) opts into being documented from its own shape;
 * one that does not still validates and narrows at runtime exactly as
 * before, and `@kavo/nest` falls back to deriving the component from the
 * entity's own ORM metadata (the same fallback `schema`'s absence already
 * takes) rather than leaving the route undocumented.
 */
export interface KavoSchema<Output> {
  safeParse(input: unknown): SchemaParseResult<Output>;
  toJSONSchema?(): object;
}

/**
 * Recovers a `KavoSchema`'s output type, the structural-contract equivalent
 * of `z.infer<typeof schema>` — core never imports `z.infer` itself, since
 * that would mean importing `zod`.
 */
export type SchemaOutput<S> = S extends KavoSchema<infer Output> ? Output : never;
