import { BadRequestException } from "@nestjs/common";
import type { ValidationError } from "class-validator";
import type { QueryIssueDto } from "@kavo/core";

/**
 * A `ValidationPipe({ exceptionFactory })` drop-in that preserves the field
 * association Nest's own default `exceptionFactory` throws away when it
 * flattens `ValidationError[]` into `message: string[]`.
 *
 * `@kavo/nest` no longer bundles this (issue #467): schema-driven validation
 * (ADR-0055) is now the source of truth for entity write bodies, so a
 * class-validator `ValidationPipe` is this app's own choice, not something
 * Kavo has an opinion about — it stays useful for `@Override()`'d routes
 * whose DTO classes carry class-validator decorators (see
 * `owner.controller.ts`), independent of whatever `schema` a `@Kavo(...)`
 * entity registers for its own generated routes.
 */
function collectFieldErrors(
  errors: readonly ValidationError[],
  ancestorPath?: string,
): { readonly field: string; readonly detail: string; readonly flatDetail: string }[] {
  const issues: { readonly field: string; readonly detail: string; readonly flatDetail: string }[] = [];
  for (const error of errors) {
    const field = ancestorPath === undefined ? error.property : `${ancestorPath}.${error.property}`;
    if (error.constraints !== undefined) {
      const detail = [...new Set(Object.values(error.constraints))].join(". ");
      const flatDetail = ancestorPath === undefined ? detail : `${ancestorPath}.${detail}`;
      issues.push({ field, detail, flatDetail });
    }
    if (error.children !== undefined && error.children.length > 0) {
      issues.push(...collectFieldErrors(error.children, field));
    }
  }
  return issues;
}

export function appValidationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const collected = collectFieldErrors(errors);
  const fieldErrors: readonly QueryIssueDto[] = collected.map(({ field, detail }) => ({ field, detail }));
  const message = collected.map(({ flatDetail }) => flatDetail).join(" ");
  return new BadRequestException({ message, fieldErrors });
}
