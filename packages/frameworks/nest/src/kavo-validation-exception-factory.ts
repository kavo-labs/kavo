import { BadRequestException } from "@nestjs/common";
import type { ValidationError } from "class-validator";
import type { QueryIssueDto } from "@kavo/core";

/**
 * The `fieldErrors` marker `toKavoExceptionShape` (`unhandled-exception.ts`)
 * looks for on an `HttpException`'s response body. Not part of Nest's own
 * `{ statusCode, message, error }` shape — it exists only so this factory's
 * output round-trips through the filter as `errors[]` (issue #437).
 */
export interface KavoValidationExceptionBody {
  readonly message: string;
  readonly fieldErrors: readonly QueryIssueDto[];
}

/**
 * One entry per **field**, not per constraint: when a property fails more
 * than one constraint, its failing messages are deduped before being
 * joined, so a message two constraints share (the `@IsNumber` +
 * `@IsPositive` example in issue #437) appears once, not twice. A nested
 * `class-validator` error (`@ValidateNested`) walks into `children`, with
 * the parent's property name dot-joined onto the child's — a node that
 * carries only `children` and no `constraints` of its own contributes no
 * entry for itself.
 *
 * `flatDetail` mirrors what Nest's own default `exceptionFactory` would
 * have produced for this entry — its `mapChildrenToValidationErrors`
 * prepends the *ancestor* path (never the leaf's own property, whose name
 * a class-validator default message already carries) onto the message
 * text — so the top-level flattened `message` this factory returns stays
 * at least as informative as Nest's default, even though the ancestor
 * path is also now available structurally as part of `field`.
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

/**
 * A `ValidationPipe({ exceptionFactory: kavoValidationExceptionFactory })`
 * drop-in that preserves the field association Nest's own default
 * `exceptionFactory` throws away when it flattens `ValidationError[]` into
 * `message: string[]` (issue #437) — a `class-validator` message with no
 * property prefix of its own (any message set via a decorator's `message`
 * option) is otherwise unrecoverable downstream. `@kavo/nest` never installs
 * a `ValidationPipe` itself (the app owns that, see
 * `examples/nest-typeorm/src/app.module.ts`), so this is opt-in: an app
 * that doesn't pass it keeps today's flattened `detail` and no `errors[]`.
 *
 * Named for Nest's own `exceptionFactory` vocabulary rather than the
 * `create*` factory convention — it is assigned to that option directly,
 * never called by application code.
 */
export function kavoValidationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const collected = collectFieldErrors(errors);
  const fieldErrors: readonly QueryIssueDto[] = collected.map(({ field, detail }) => ({ field, detail }));
  const message = collected.map(({ flatDetail }) => flatDetail).join(" ");
  const body: KavoValidationExceptionBody = { message, fieldErrors };
  return new BadRequestException(body);
}
