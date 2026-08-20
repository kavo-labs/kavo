import type { KavoContext } from "../context/kavo-context.js";
import type { FilterExpression } from "../query/filter.js";

/**
 * The optional-field shape the built-in policy nodes (`permission`, `role`,
 * `owner`, `authenticated`) read off `context.principal` (ADR-0032).
 *
 * `KavoContext.principal` itself stays `unknown` — Kavo still never
 * inspects, validates, or shapes it on its own. This interface is only what
 * an application opts into by using the built-in nodes; a `when()`
 * predicate can read `context.principal` however it likes instead, and an
 * application whose principal doesn't have this shape simply doesn't use
 * the built-in nodes. The index signature is what lets an application add
 * `tenantId`, `plan`, or any other field without a Kavo change.
 */
export interface KavoPrincipal {
  readonly userId?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * A policy decision tree (ADR-0032). Built by `permission`/`role`/`owner`/
 * `authenticated`/`when` and composed with `and`/`or`/`not` — every node is
 * plain, inspectable data except `when`, which necessarily holds a closure
 * (there is no way to make an arbitrary predicate inspectable). A resolved
 * `OperationConfig.policy` entry is one of these, evaluated by the engine's
 * policy stage before a request reaches its handler.
 */
export type PolicyNode<Entity = unknown> =
  | { readonly type: "permission"; readonly name: string }
  | { readonly type: "role"; readonly name: string }
  | { readonly type: "owner"; readonly field: string }
  | { readonly type: "authenticated" }
  | { readonly type: "filtered"; readonly field: string }
  | {
      readonly type: "when";
      readonly predicate: (context: KavoContext<Entity>, entity?: Entity) => boolean | Promise<boolean>;
    }
  | { readonly type: "and"; readonly children: readonly PolicyNode<Entity>[] }
  | { readonly type: "or"; readonly children: readonly PolicyNode<Entity>[] }
  | { readonly type: "not"; readonly child: PolicyNode<Entity> };

/** The array shorthand a `policy.<operation>` entry also accepts — sugar for `and(...names.map(permission))`. */
export type PolicyShorthand<Entity = unknown> = readonly string[] | PolicyNode<Entity>;

/** `policy: ['post:update']` → `and(permission('post:update'))`; a single-name array stays a bare `permission` node. */
export function normalizePolicyShorthand<Entity = unknown>(shorthand: PolicyShorthand<Entity>): PolicyNode<Entity> {
  if (!Array.isArray(shorthand)) return shorthand as PolicyNode<Entity>;
  const names = shorthand as readonly string[];
  return names.length === 1 ? permission(names[0]!) : and(...names.map((name) => permission<Entity>(name)));
}

export function permission<Entity = unknown>(name: string): PolicyNode<Entity> {
  return { type: "permission", name };
}

export function role<Entity = unknown>(name: string): PolicyNode<Entity> {
  return { type: "role", name };
}

/** `owner('authorId')` checks `entity.authorId === principal.userId`; dotted paths (`owner('author.id')`) address a nested field. */
export function owner<Entity = unknown>(field = "userId"): PolicyNode<Entity> {
  return { type: "owner", field };
}

/** `principal.userId != null`. */
export function authenticated<Entity = unknown>(): PolicyNode<Entity> {
  return { type: "authenticated" };
}

/**
 * `context.query.filter` carries a condition on `field` — 403s a read whose
 * caller omitted a required filter, e.g. `filtered("userId")` on `findMany`
 * to force every list request to scope itself by `userId`.
 *
 * Reads `context.query`, which is only populated on read operations;
 * `context.query` is `null` on writes, so `filtered` denies unconditionally
 * there rather than throwing. It does not need the loaded row — it is its
 * own node type rather than a `when()` wrapper precisely so it stays
 * context-only: `policyNeedsEntity` returns `false` for it, so (unlike
 * `owner`/`when`) it is legal on `createOne`/`findMany` too.
 */
export function filtered<Entity = unknown>(field: string): PolicyNode<Entity> {
  return { type: "filtered", field };
}

function filterHasField(expression: FilterExpression<unknown> | null, field: string): boolean {
  if (expression === null) return false;
  if (expression.kind === "condition") return expression.field === field;
  return expression.children.some((child) => filterHasField(child, field));
}

/** Escape hatch for a check the other nodes can't express. Not inspectable — see `policyNeedsEntity`'s doc comment. */
export function when<Entity = unknown>(
  predicate: (context: KavoContext<Entity>, entity?: Entity) => boolean | Promise<boolean>,
): PolicyNode<Entity> {
  return { type: "when", predicate };
}

export function and<Entity = unknown>(...children: readonly PolicyNode<Entity>[]): PolicyNode<Entity> {
  return { type: "and", children };
}

export function or<Entity = unknown>(...children: readonly PolicyNode<Entity>[]): PolicyNode<Entity> {
  return { type: "or", children };
}

export function not<Entity = unknown>(child: PolicyNode<Entity>): PolicyNode<Entity> {
  return { type: "not", child };
}

function principalOf<Entity>(context: KavoContext<Entity>): KavoPrincipal {
  return (context.principal as KavoPrincipal | null | undefined) ?? {};
}

function getAtPath(entity: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, entity);
}

/**
 * `true` when `node` (or a descendant) is `owner`/`when` — the two node
 * types whose result depends on the entity, not only on `context`. The
 * engine's policy stage uses this to decide whether it must load the row
 * before evaluating, and `resolveEntityConfig` uses it to reject an
 * entity-aware node configured on `createOne`/`findMany`, where no single
 * entity exists to check (ADR-0032).
 */
export function policyNeedsEntity<Entity>(node: PolicyNode<Entity>): boolean {
  switch (node.type) {
    case "owner":
    case "when":
      return true;
    case "and":
    case "or":
      return node.children.some(policyNeedsEntity);
    case "not":
      return policyNeedsEntity(node.child);
    default:
      return false;
  }
}

/**
 * Every `owner(field)` string reachable from `node` — what
 * `resolveEntityConfig` walks to reject a field that crosses a relation
 * boundary (ADR-0032): the policy stage's pre-fetch loads no relations, so
 * `owner('author.id')` would silently deny every caller instead of failing
 * loudly at bootstrap.
 */
export function collectOwnerFields<Entity>(node: PolicyNode<Entity>): readonly string[] {
  switch (node.type) {
    case "owner":
      return [node.field];
    case "and":
    case "or":
      return node.children.flatMap(collectOwnerFields);
    case "not":
      return collectOwnerFields(node.child);
    default:
      return [];
  }
}

/** Evaluate a policy node against a request's context and (when loaded) its entity. */
export async function evaluatePolicy<Entity>(
  node: PolicyNode<Entity>,
  context: KavoContext<Entity>,
  entity?: Entity,
): Promise<boolean> {
  switch (node.type) {
    case "permission": {
      const principal = principalOf(context);
      return (principal.permissions ?? []).includes(node.name);
    }
    case "role": {
      const principal = principalOf(context);
      return (principal.roles ?? []).includes(node.name);
    }
    case "authenticated": {
      const principal = principalOf(context);
      return principal.userId != null;
    }
    case "owner": {
      const principal = principalOf(context);
      if (principal.userId == null || entity === undefined) return false;
      return getAtPath(entity, node.field) === principal.userId;
    }
    case "filtered":
      return filterHasField(context.query?.filter.root ?? null, node.field);
    case "when":
      return node.predicate(context, entity);
    case "and": {
      for (const child of node.children) {
        if (!(await evaluatePolicy(child, context, entity))) return false;
      }
      return true;
    }
    case "or": {
      for (const child of node.children) {
        if (await evaluatePolicy(child, context, entity)) return true;
      }
      return false;
    }
    case "not":
      return !(await evaluatePolicy(node.child, context, entity));
  }
}
