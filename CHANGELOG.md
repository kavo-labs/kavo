# Changelog

## [0.15.0](https://github.com/kavo-labs/kavo/compare/v0.14.7...v0.15.0) (2026-08-29)

### ⚠ BREAKING CHANGES

- **core:** `query.search.enabled` is removed. Set `query.search` to an object (`{}` for the defaults) to turn search on, or `false` to disable it.

### Features

- **core:** reshape query.search to SearchSettings | false ([6b91896](https://github.com/kavo-labs/kavo/commit/6b918968385e4c0f5e8483e57dce91846d14cae6))

### Documentation

- document query.search as an object-or-false setting ([7c46be7](https://github.com/kavo-labs/kavo/commit/7c46be7fa70b0db92e4a201cb334a6d2c11d99cd))

### CI

- cut releases without a PAT and credit release-please[bot] ([#300](https://github.com/kavo-labs/kavo/issues/300)) ([1970608](https://github.com/kavo-labs/kavo/commit/19706082201f6c420888ebf699f2ed015b12377a))
- cut the release without a PAT when the release PR merges ([#299](https://github.com/kavo-labs/kavo/issues/299)) ([071202e](https://github.com/kavo-labs/kavo/commit/071202ee9b8de977203e56d927be3a070441217f))
- name the grouped release PR with the version ([3b733c2](https://github.com/kavo-labs/kavo/commit/3b733c2b9ea58330ba61cd71b6107d77c12ea5b0))

## [0.14.7](https://github.com/kavo-labs/kavo/compare/v0.14.6...v0.14.7) (2026-08-29)

### Features

- **nest:** add per-entity Swagger tags and x-kavo-* vendor extensions to generated routes ([#295](https://github.com/kavo-labs/kavo/issues/295)) ([e9fc015](https://github.com/kavo-labs/kavo/commit/e9fc015a2a728b62fd8523300eefc63635fe9533))
- **nest:** add x-kavo-cardinality swagger extension ([4e92be0](https://github.com/kavo-labs/kavo/commit/4e92be01b4aa66ca28c0e512320acdcd10a181ca))

### Tests

- **nest-typeorm:** add per-entity e2e suites for every /cats-and-siblings route ([9785279](https://github.com/kavo-labs/kavo/commit/97852795405139e73dcadded0fe816a1a467c091))

### CI

- cut releases with release-please ([#296](https://github.com/kavo-labs/kavo/issues/296)) ([362b43a](https://github.com/kavo-labs/kavo/commit/362b43aa282b72a66a02af1b7d4ec0f1e14b7823))
- version the release-please PR title ([#298](https://github.com/kavo-labs/kavo/issues/298)) ([abfa5fd](https://github.com/kavo-labs/kavo/commit/abfa5fdcedfc317d2807e4f3ae8f3777e6cd30eb))
