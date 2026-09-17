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
   * {@link QueryIssueDto.field} the same way `class-validator`'s nested
   * `children` already are in `kavo-validation-exception-factory.ts`.
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
 * value must satisfy. Deliberately minimal — one method, one result shape —
 * so it constrains nothing about the library that produced it.
 */
export interface KavoSchema<Output> {
  safeParse(input: unknown): SchemaParseResult<Output>;
}

/**
 * Recovers a `KavoSchema`'s output type, the structural-contract equivalent
 * of `z.infer<typeof schema>` — core never imports `z.infer` itself, since
 * that would mean importing `zod`.
 */
export type SchemaOutput<S> = S extends KavoSchema<infer Output> ? Output : never;
