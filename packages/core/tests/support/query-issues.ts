import { QueryValidationException } from "@kavo/core";

/**
 * Run `fn` and return the issues of the `QueryValidationException` it must
 * raise. The final throw is what stops a test from passing vacuously when
 * the call unexpectedly succeeds.
 */
export function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueryValidationException) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected QueryValidationException");
}
