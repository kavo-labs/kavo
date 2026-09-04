// Type vocabulary mirrors docs/../conventions skill: feat, fix, chore, test,
// docs, refactor, perf, ci. `type(scope)!: subject` (a breaking change) must
// keep validating against this list — the `!` is parsed out of the header
// before type-enum runs, so it never needs special-casing here.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", ["feat", "fix", "chore", "test", "docs", "refactor", "perf", "ci"]],
  },
};
