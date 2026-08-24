import { createRequire } from "node:module";
import type { ClassRef } from "@kavo/core";

type ClassValidatorModule = {
  getMetadataStorage(): {
    getTargetValidationMetadatas(
      targetConstructor: Function,
      targetSchema: string,
      always: boolean,
      strictGroups: boolean,
    ): readonly unknown[];
  };
};

let cached: ClassValidatorModule | null | undefined;

/**
 * `class-validator` is an *optional* peer, loaded synchronously (like
 * `@nestjs/swagger` in `swagger.ts`) because `@Kavo`'s route generation runs
 * at class-decoration time (ADR-0012), which cannot await a dynamic import.
 */
function loadClassValidator(): ClassValidatorModule | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    cached = require("class-validator") as ClassValidatorModule;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Whether `entity` itself carries any `class-validator` decorator — the
 * gate for issue #283's entity-class DTO fallback. `@kavo/nest` writes
 * `design:paramtypes` generically for *any* validation library hooked
 * through Nest's pipe system (issue #281's fix is not tied to one), but the
 * fallback itself must be library-aware: an undecorated entity has no
 * validation rules to gain, and under `ValidationPipe({ whitelist: true })`
 * — this repo's own example config — naming an undecorated class as the
 * body's metatype would strip every property instead of validating them,
 * a silent-data-loss regression worse than the silent-no-validation gap
 * #283 exists to close. Returns `false`, not an error, when `class-validator`
 * itself isn't installed — the fallback then behaves exactly like today,
 * for a library-agnostic app that hooks a different validator.
 */
export function entityHasValidationMetadata(entity: ClassRef): boolean {
  const classValidator = loadClassValidator();
  if (classValidator === null) return false;
  const target = entity as unknown as Function;
  return classValidator.getMetadataStorage().getTargetValidationMetadatas(target, "", true, false).length > 0;
}
