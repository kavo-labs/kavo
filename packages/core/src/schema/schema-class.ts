import type { KavoSchema } from "./kavo-schema.js";

/** A registerable class: plain, no-argument, shape-only — today's `DtoClass`, renamed and folded into `schema`. */
export type SchemaClass<Shape extends object = object> = new () => Shape;

/** Every `schema.<slot>` position accepts either a validator or a plain class. */
export type SchemaLike<T extends object = object> = KavoSchema<T> | SchemaClass<T>;

/** Structural check: a class constructor has no `safeParse`, a `KavoSchema` does. */
export function isSchemaClass(value: unknown): value is SchemaClass<any> {
  return typeof value === "function";
}
