import { mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/**
 * `pnpm test:coverage` — the same suite `pnpm test` runs, measured.
 *
 * It is a separate config rather than a flag on the main one because
 * coverage instrumentation is pure overhead for the run developers do
 * hundreds of times a day, and because the thresholds below only make
 * sense against the *whole* suite. Measuring a single file would report
 * every other file as uncovered and fail.
 *
 * The thresholds are a ratchet, not a target. They sit just under what the
 * suite achieves today, so an ordinary change has room to move while a
 * real regression fails the run. They are deliberately **not** 100:
 * roughly a third of the remaining uncovered lines are guards that no
 * input can reach — `assertNever` arms over closed unions, `??` fallbacks
 * the calling layer has already collapsed, and type-narrowing checks like
 * `bracket-notation.ts`'s unclosed-bracket return, which the
 * `endsWith("]")` precondition above it makes unreachable. Tests written
 * to close those would assert nothing and still have to be maintained.
 * Raise these numbers when real coverage rises; do not chase the gap.
 */
export default mergeConfig(base, {
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      // Published sources only. The `examples/*` apps are exercised
      // end-to-end by their own suites, but they are reference wiring
      // rather than shipped code, and holding them to a package
      // threshold would measure the wrong thing.
      include: ["packages/**/src/**/*.ts"],
      exclude: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "./.coverage",
      // Achieved at the time of writing: 98.19 / 96.04 / 99.27 / 98.23.
      //
      // The gaps below those numbers are budgets, not rounding. Each one
      // is worth roughly 40 branches or 10 functions, which is wide enough
      // that the job does not go red for reasons unrelated to coverage —
      // v8 derives its counts from V8 itself, so they can shift a little
      // when the `lts/*` the job runs on rolls to a new major — and still
      // narrow enough that losing a real behavior's tests fails the run.
      // Tighten them when coverage rises; a threshold pinned flush against
      // the current number is a flaky gate, not a strict one.
      thresholds: {
        statements: 98,
        branches: 96,
        functions: 98,
        lines: 98,
      },
    },
  },
});
