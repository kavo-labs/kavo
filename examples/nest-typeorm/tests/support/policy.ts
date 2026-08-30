import type { Policy } from "@kavo/core";

// The helpers read `context.app` typed via the fields `src/kavo-app-context.d.ts`
// declares on `KavoAppContext` — a header-driven test guard writes that shape.

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
