import type { KavoSchema } from "./kavo-schema.js";

/** A registerable class: plain, no-argument, shape-only. */
export type SchemaClass<Shape extends object = object> = new () => Shape;

/** Every `schema.<slot>` position accepts either a validator or a plain class. */
export type SchemaLike<T extends object = object> = KavoSchema<T> | SchemaClass<T>;

/**
 * Structural check: a class constructor has no `safeParse`, a `KavoSchema`
 * does. A callable validator (some schema libraries' results are functions)
 * therefore still counts as a validator.
 */
export function isSchemaClass(value: unknown): value is SchemaClass<any> {
  return typeof value === "function" && typeof (value as { safeParse?: unknown }).safeParse !== "function";
}
