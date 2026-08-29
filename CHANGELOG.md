# Changelog

## [0.15.3](https://github.com/kavo-labs/kavo/compare/v0.15.2...v0.15.3) (2026-08-29)


### CI

* let release-please own the GitHub Release, drop it from publish.yml ([#308](https://github.com/kavo-labs/kavo/issues/308)) ([ae014fb](https://github.com/kavo-labs/kavo/commit/ae014fbe209ce0b99e99cd1d55466f0f21ac09b5))

## [0.15.2](https://github.com/kavo-labs/kavo/compare/v0.15.1...v0.15.2) (2026-08-29)


### Bug Fixes

* **nest:** include computed fields in the synthesized Swagger response schema ([#306](https://github.com/kavo-labs/kavo/issues/306)) ([d5095c0](https://github.com/kavo-labs/kavo/commit/d5095c0bdf513c146ce9f18e82f6adf14e0d894d))


### CI

* pass --repo to the publish.yml hand-off ([0d41ea0](https://github.com/kavo-labs/kavo/commit/0d41ea0532d93682f90887a9c2ea28402bdbc517))

## [0.15.1](https://github.com/kavo-labs/kavo/compare/v0.15.0...v0.15.1) (2026-08-29)

### Documentation

- **adr:** clarify the grouped release PR title is vX.Y.Z, not ${branch} ([9e0d540](https://github.com/kavo-labs/kavo/commit/9e0d5401d3516ff39fd0c9bf1f8dcb60c104f156))

### CI

- add a workflow_dispatch hatch to publish.yml ([527a7e2](https://github.com/kavo-labs/kavo/commit/527a7e2f7125c9bf145cfe6a687f10ac7445b7bf))
- auto-cut releases via a schedule tick, no PAT or GitHub App ([7f6f34f](https://github.com/kavo-labs/kavo/commit/7f6f34f0d3415dea239975d628aa12d4bcb2fbdc))
- drop package-name so the release PR component round-trips ([76c8bc1](https://github.com/kavo-labs/kavo/commit/76c8bc1a398033420f593eb3d61d5b430e251c7b))
- keep ${component} in the release PR title pattern so releases cut ([eda67f0](https://github.com/kavo-labs/kavo/commit/eda67f014ecf3f7a7bdee30890baec9431e74712))
- put the package name in the release PR title so releases cut ([077eb6a](https://github.com/kavo-labs/kavo/commit/077eb6ab4c55425fb9e21f74fb12b941e2fa4760))
- run release-please with a GitHub App token so releases auto-cut ([b7aec72](https://github.com/kavo-labs/kavo/commit/b7aec7236b510b971fa92bbc585a4cfd87ce0b2f))
- set package-name "" so release-please actually cuts the tag ([5791697](https://github.com/kavo-labs/kavo/commit/5791697d4ec5a14037f85f688b5c2d00c02f4c0c))

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
