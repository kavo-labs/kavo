import type { Policy } from "@kavo/core";
import { Owner } from "./owner.entity.js";

interface OwnerPrincipal {
  readonly permissions?: readonly string[];
}

/** `context.principal` shape `OwnerPrincipalGuard` writes — a comma-separated `x-permissions` header. */
export function hasPermission(name: string): Policy<Owner> {
  return ({ context }) => {
    const principal = context.principal as OwnerPrincipal | null | undefined;
    return (principal?.permissions ?? []).includes(name);
  };
}
