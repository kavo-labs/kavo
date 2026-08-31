import type { FieldSelectionInput, QueryContext } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Type-level acceptance tests for the three `fields` spellings. The runtime
 * half — that all three collapse to the *same* normalized selection — lives
 * in query-normalizer.spec.ts; these only pin what the compiler accepts.
 */

// 1. Root-only sugar, mirroring `?select=id,name`. This is the spelling the
//    doc comment on `QueryContext.select` promised while the type rejected it.
const bare: FieldSelectionInput<Author> = ["id", "name"];
void bare;

// 2. The structured form.
const structured: FieldSelectionInput<Author> = { root: ["id"], relations: { posts: ["title"] } };
void structured;

// Either half of the structured form alone.
const rootOnly: FieldSelectionInput<Author> = { root: ["name"] };
const relationsOnly: FieldSelectionInput<Author> = { relations: { posts: ["title"] } };
void rootOnly;
void relationsOnly;

// 3. Relation-keyed, mirroring `?select[posts]=title`. This is the spelling
//    from the issue's example that did not compile before.
const relationKeyed: FieldSelectionInput<Author> = { posts: ["id", "title"] };
void relationKeyed;

// All three arrive through `QueryContext` with no manual generic argument.
const queries: readonly QueryContext<Author>[] = [
  { select: ["id", "name"] },
  { select: { root: ["id"], relations: { posts: ["title"] } } },
  { select: { posts: ["id", "title"] } },
];
void queries;

// @ts-expect-error — root selection is depth 1: relation paths belong in
// `relations`, not in the root list.
const deepRoot: FieldSelectionInput<Author> = ["posts.title"];
void deepRoot;

// @ts-expect-error — a misspelled root field is still a compile error.
const typo: FieldSelectionInput<Author> = ["nmae"];
void typo;

// @ts-expect-error — a relation fieldset is a list of names, not a bare string.
const notAList: FieldSelectionInput<Author> = { posts: "title" };
void notAList;
