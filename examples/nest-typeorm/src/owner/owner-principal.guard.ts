import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

/**
 * Stands in for whatever a real app's auth layer does — reads a
 * comma-separated `x-permissions` header into the shape `policy`'s
 * `permission()` node reads off `context.principal` (`KavoPrincipal`,
 * `@kavo/core`). A real app authenticates with a JWT/session guard and
 * derives permissions from the account it resolves; this is the minimal
 * stand-in that makes `OwnerController`'s `policy.deleteOne` demonstrable
 * over real HTTP without pulling an auth library into the reference app.
 *
 * `KavoModule.forRootAsync`'s `principal: true` (`app.module.ts`) is what
 * moves `request.user` onto `context.principal` — this guard only ever
 * sets `request.user`, never reads `context` itself, so it composes with
 * that option rather than duplicating it (`docs/guides/wiring-your-own-auth`).
 */
@Injectable()
export class OwnerPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const permissions = request.headers["x-permissions"];
    if (permissions === undefined) return true;
    request.user = { permissions: permissions.split(",").filter(Boolean) };
    return true;
  }
}
