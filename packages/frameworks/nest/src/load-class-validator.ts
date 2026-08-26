import { createRequire } from "node:module";
import type { ClassRef } from "@kavo/core";

type ClassValidatorModule = {
  getMetadataStorage(): {
    getTargetValidationMetadatas(
      targetConstructor: Function,
      targetSchema: string,
      always: boolean,
      strictGroups: boolean,
    ): readonly { propertyName: string }[];
  };
  IsOptional(validationOptions?: object): PropertyDecorator;
};

let cached: ClassValidatorModule | null | undefined;

/**
 * `class-validator` is an *optional* peer, loaded synchronously (like
 * `@nestjs/swagger` in `swagger.ts`) because `@Kavo`'s route generation runs
 * at class-decoration time (ADR-0012), which cannot await a dynamic import.
 */
function loadClassValidator(): ClassValidatorModule | null {
  if (cached !== undefined) {
    return cached;
  }
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
  if (classValidator === null) {
    return false;
  }
  const target = entity as unknown as Function;
  return classValidator.getMetadataStorage().getTargetValidationMetadatas(target, "", true, false).length > 0;
}

const partialClasses = new WeakMap<ClassRef, ClassRef>();

/**
 * Issue #285: `patchOne`'s entity-class fallback (#283) named the entity
 * class itself as the body metatype, so every field the entity's own
 * `class-validator` decorators require became required on a partial `PATCH`
 * body too — rejecting any body that omits one. Builds (and caches, per
 * entity) a subclass that inherits the entity's decorators — `class-validator`
 * resolves inherited metadata through the prototype chain — plus an
 * `@IsOptional()` on every one of its decorated properties, which
 * `class-validator` runs first and short-circuits: a property that's
 * `undefined`/`null` skips its other validators instead of failing them.
 * Returns `null` under the same gate as `entityHasValidationMetadata` — an
 * entity with no validation decorators has nothing to make optional.
 */
export function entityPartialValidationClass(entity: ClassRef): ClassRef | null {
  const classValidator = loadClassValidator();
  if (classValidator === null) {
    return null;
  }
  const cached = partialClasses.get(entity);
  if (cached !== undefined) {
    return cached;
  }
  const target = entity as unknown as Function;
  const metadatas = classValidator.getMetadataStorage().getTargetValidationMetadatas(target, "", true, false);
  if (metadatas.length === 0) {
    return null;
  }
  class PartialEntityDto extends (entity as unknown as new (...args: never[]) => object) {}
  Object.defineProperty(PartialEntityDto, "name", { value: `Partial${target.name}` });
  const propertyNames = new Set(metadatas.map((metadata) => metadata.propertyName));
  for (const propertyName of propertyNames) {
    classValidator.IsOptional()(PartialEntityDto.prototype, propertyName);
  }
  const partialClass = PartialEntityDto as unknown as ClassRef;
  partialClasses.set(entity, partialClass);
  return partialClass;
}
