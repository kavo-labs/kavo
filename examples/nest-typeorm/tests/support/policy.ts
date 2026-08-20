import type { KavoContext, Policy } from "@kavo/core";

/** Reads `permissions`/`roles`/`userId` off `context.principal` — the shape a header-driven test guard writes there. */
export interface Principal {
  readonly userId?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
}

export function principalOf<Entity>(context: KavoContext<Entity>): Principal {
  return (context.principal as Principal | null | undefined) ?? {};
}

export function hasPermission<Entity>(name: string): Policy<Entity> {
  return ({ context }) => (principalOf(context).permissions ?? []).includes(name);
}

export function hasRole<Entity>(name: string): Policy<Entity> {
  return ({ context }) => (principalOf(context).roles ?? []).includes(name);
}

export function isAuthenticated<Entity>(): Policy<Entity> {
  return ({ context }) => principalOf(context).userId != null;
}

export function isOwner<Entity>(field: string): Policy<Entity> {
  return ({ context, entity }) => {
    const principal = principalOf(context);
    if (principal.userId == null || entity === undefined) return false;
    return (entity as unknown as Record<string, unknown>)[field] === principal.userId;
  };
}
