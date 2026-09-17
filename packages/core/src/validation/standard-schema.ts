/**
 * The Standard Schema V1 contract (https://standardschema.dev). `EntityConfig.schema`
 * (`entity-config.ts`) accepts anything implementing this shape — Zod 4+,
 * Valibot, ArkType, and others all do — rather than any one validation
 * library's own type, so this stays the only validation-adjacent type core
 * declares and core still imports no validation library (ADR-0056). Copied
 * from the spec rather than depending on the `@standard-schema/spec`
 * package: it is three small interfaces with no behavior, and a dependency
 * here would be the one place `@kavo/core`'s zero-runtime-dependency rule
 * (ADR-0005) would have an exception to explain.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace -- mirrors the spec's own shape exactly
export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): Result<Output> | Promise<Result<Output>>;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: readonly Issue[];
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment>;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }
}
