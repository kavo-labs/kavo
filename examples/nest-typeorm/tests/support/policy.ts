import type { KavoAppContext, KavoContext, Policy } from "@kavo/core";

/**
 * The `context.app` shape a header-driven test guard writes — the same
 * fields `src/kavo-app-context.d.ts` declares on `KavoAppContext`, so these
 * helpers read them typed.
 */
export type AppContext = KavoAppContext;

export function appContextOf<Entity>(context: KavoContext<Entity>): AppContext {
  return context.app;
}

export function hasPermission<Entity>(name: string): Policy<Entity> {
  return ({ context }) => (context.app.permissions ?? []).includes(name);
}

export function hasRole<Entity>(name: string): Policy<Entity> {
  return ({ context }) => (context.app.roles ?? []).includes(name);
}

export function isAuthenticated<Entity>(): Policy<Entity> {
  return ({ context }) => context.app.userId != null;
}

export function isOwner<Entity>(field: string): Policy<Entity> {
  return ({ context, entity }) => {
    const { userId } = context.app;
    if (userId == null || entity === undefined) {
      return false;
    }
    return (entity as unknown as Record<string, unknown>)[field] === userId;
  };
}
