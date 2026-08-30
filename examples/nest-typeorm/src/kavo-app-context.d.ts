/**
 * This app's `KavoContext.app` shape. A guard (`owner-app-context.guard.ts`)
 * populates `request.user`, and `KavoModule`'s `app` extractor
 * (`app.module.ts`) copies it onto `context.app` for every request — so a
 * policy or a custom handler reads these fields with full typing and no
 * cast. A real app would derive them from an authenticated session.
 */
declare module "@kavo/core" {
  interface KavoAppContext {
    readonly userId?: string;
    readonly roles?: readonly string[];
    readonly permissions?: readonly string[];
  }
}

export {};
