// Type vocabulary mirrors the conventions skill's table plus the rest of
// @commitlint/config-conventional's own default list (build, revert, style),
// kept available for the cases the documented eight don't cover.
// `type(scope)!: subject` (a breaking change) must keep validating against
// this list — the `!` is parsed out of the header before type-enum runs, so
// it never needs special-casing here.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "chore", "test", "docs", "refactor", "perf", "ci", "build", "revert", "style"],
    ],
  },
};
