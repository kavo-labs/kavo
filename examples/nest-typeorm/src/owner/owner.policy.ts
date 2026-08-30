import type { Policy } from "@kavo/core";
import { Owner } from "./owner.entity.js";

/**
 * Reads the `permissions` this app declares on `KavoContext.app`
 * (`src/kavo-app-context.d.ts`), which `OwnerAppContextGuard` writes as a
 * comma-separated `x-permissions` header.
 */
export function hasPermission(name: string): Policy<Owner> {
  return ({ context }) => (context.app.permissions ?? []).includes(name);
}
