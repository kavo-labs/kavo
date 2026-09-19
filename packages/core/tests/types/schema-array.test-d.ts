import type { EntityConfig } from "@kavo/core";
import { User } from "../support/user-fixture.js";

/** A bare field array is a valid `schema` at every position, and field names are checked against the entity. */
export const wholeSchema: EntityConfig<User> = { schema: ["email", "name"] };
export const inputArray: EntityConfig<User> = { schema: { input: ["email", "name"] } };
export const createArray: EntityConfig<User> = { schema: { input: { create: ["email"] } } };
export const outputArray: EntityConfig<User> = { schema: { output: { item: ["id"], list: ["id", "email"] } } };

// @ts-expect-error — "nope" is not a field of User
export const badField: EntityConfig<User> = { schema: { input: ["nope"] } };
