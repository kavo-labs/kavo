/**
 * The operation entry shape `Ops[Id]` resolves to, or `undefined` when `Id`
 * was never declared. Read by the `Schema*Of` type-inference helpers
 * (`schema/entity-schema.ts`) and by `service/custom-operation.ts`, which
 * reads the same `Ops` literal for a custom operation's handler signature.
 */
export type OperationEntryOf<Ops, Id extends string> = Id extends keyof Ops ? Ops[Id] : undefined;
