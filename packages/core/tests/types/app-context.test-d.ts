import { expectTypeOf } from "vitest";
import type { KavoAppContext, KavoCallOptions, KavoContext } from "@kavo/core";

// `KavoContext.app` is the app-defined context, typed by the augmentable
// `KavoAppContext` interface — the same type `KavoCallOptions.app` accepts.
expectTypeOf<KavoContext["app"]>().toEqualTypeOf<KavoAppContext>();
expectTypeOf<KavoCallOptions["app"]>().toEqualTypeOf<KavoAppContext | undefined>();

// Unaugmented, `KavoAppContext` carries no fields: an app that has not
// declared its shape gets a compile error on every `context.app.<field>`
// read — the signal to write `declare module "@kavo/core"`. (The core test
// project ships no augmentation, so this holds here; the example app's
// `src/kavo-app-context.d.ts` exercises the merged, typed side.)
expectTypeOf<keyof KavoAppContext>().toEqualTypeOf<never>();

declare const context: KavoContext;
// @ts-expect-error — no field is declared on the bare KavoAppContext.
export const appHasNoDeclaredField: unknown = context.app.userId;
