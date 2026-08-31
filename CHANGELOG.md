# Changelog

## [0.17.1](https://github.com/kavo-labs/kavo/compare/v0.17.0...v0.17.1) (2026-08-31)


### Bug Fixes

* **nest:** document includable relations in the synthesized response schema ([#350](https://github.com/kavo-labs/kavo/issues/350)) ([35cf193](https://github.com/kavo-labs/kavo/commit/35cf1936fb17400294b0cd68c716dc949c680d52))

## [0.17.0](https://github.com/kavo-labs/kavo/compare/v0.16.2...v0.17.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **core:** the `fields` / `fields[<relation>]` query parameter is renamed to `select` / `select[<relation>]` with no backward-compatible alias. `QueryContext.fields` and `NormalizedQueryContext.fields` are renamed to `select`.

### Features

* **core:** cap an included relation's projection from allowlists.selectable ([#345](https://github.com/kavo-labs/kavo/issues/345)) ([cf29d6b](https://github.com/kavo-labs/kavo/commit/cf29d6b5210c08c2b5c199a1175ba76d98b87eaf))
* **core:** rename the `fields` query parameter to `select` ([#347](https://github.com/kavo-labs/kavo/issues/347)) ([a048236](https://github.com/kavo-labs/kavo/commit/a0482369ca8b690b5d2f608c28bb48a082b9c291))

## [0.16.2](https://github.com/kavo-labs/kavo/compare/v0.16.1...v0.16.2) (2026-08-31)


### Bug Fixes

* **nest:** document relation properties in the synthesized fallback body schema ([#340](https://github.com/kavo-labs/kavo/issues/340)) ([ead5a23](https://github.com/kavo-labs/kavo/commit/ead5a23826be4b9b13bdf50c34c9767671ce28ba))

## [0.16.1](https://github.com/kavo-labs/kavo/compare/v0.16.0...v0.16.1) (2026-08-30)


### Documentation

* design spec for app context replacing principal ([4e43730](https://github.com/kavo-labs/kavo/commit/4e437308f01b8200228f512c93c97b5aa35305de))
* drop default policy accessors from app-context spec ([f8c5da4](https://github.com/kavo-labs/kavo/commit/f8c5da42365bf0a2d409f3f758aa4a288a9cd4ef))
* full principal removal, no compat, in app-context spec ([c25ec87](https://github.com/kavo-labs/kavo/commit/c25ec8716d69d6631108d796d36f930ba3fb969a))

## [0.16.0](https://github.com/kavo-labs/kavo/compare/v0.15.5...v0.16.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* `KavoContext.principal`, `KavoContextInit.principal` and `KavoCallOptions.principal` are removed. Use `KavoContext.app` and declare `KavoAppContext`'s shape via module augmentation. See ADR-0043.

### Refactoring

* replace KavoContext.principal with an app-defined KavoContext.app ([#333](https://github.com/kavo-labs/kavo/issues/333)) ([aa73662](https://github.com/kavo-labs/kavo/commit/aa73662daf7b62832c3f4d4373d8c86a70949516))

## [0.15.5](https://github.com/kavo-labs/kavo/compare/v0.15.4...v0.15.5) (2026-08-30)


### Features

* **example:** add structured-JSON `vitals` column to Dog entity ([#324](https://github.com/kavo-labs/kavo/issues/324)) ([89bf64c](https://github.com/kavo-labs/kavo/commit/89bf64c8772a573bd44986023a1e9a1e4b594673))
* **nest:** add <Entity>Filter/<Entity>Query component schemas ([#318](https://github.com/kavo-labs/kavo/issues/318)) ([29fd08a](https://github.com/kavo-labs/kavo/commit/29fd08a4d543623e488fa7796ca63ad9a2bf4993)), closes [#314](https://github.com/kavo-labs/kavo/issues/314)
* **nest:** add <Entity>Pagination/Include/Sort query-param component schemas ([#317](https://github.com/kavo-labs/kavo/issues/317)) ([0347203](https://github.com/kavo-labs/kavo/commit/034720383fa9fbcbaebccfe23b9645f31d524bb4)), closes [#313](https://github.com/kavo-labs/kavo/issues/313)
* **nest:** derive Swagger schema `required` from column nullability ([#322](https://github.com/kavo-labs/kavo/issues/322)) ([74f5fdc](https://github.com/kavo-labs/kavo/commit/74f5fdca71138651b9b35f10149ae59285e1224c))
* **nest:** wire registerKavoSchemas into the nest-typeorm example ([#315](https://github.com/kavo-labs/kavo/issues/315)) ([a560e4e](https://github.com/kavo-labs/kavo/commit/a560e4e69ad4adb70550d341e1314f5871e8d09e))


### Bug Fixes

* **nest:** shape <Entity>Pagination schema to the resolved pagination strategy ([#320](https://github.com/kavo-labs/kavo/issues/320)) ([a8f0e36](https://github.com/kavo-labs/kavo/commit/a8f0e36a069a3fe07ecae9fd42522a60521d08a1)), closes [#319](https://github.com/kavo-labs/kavo/issues/319)

## [0.15.4](https://github.com/kavo-labs/kavo/compare/v0.15.3...v0.15.4) (2026-08-29)


### Features

* **nest:** register generated DTO schemas as named components/schemas ([#310](https://github.com/kavo-labs/kavo/issues/310)) ([ff674b5](https://github.com/kavo-labs/kavo/commit/ff674b5d9467896a32f9f2fffcd54414f1111a0d))

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

## [0.14.6](https://github.com/kavo-labs/kavo/compare/v0.14.5...v0.14.6) (2026-08-27)


### Bug Fixes

- **core:** reject bare scalar id for single-key relation association ([#293](https://github.com/kavo-labs/kavo/issues/293)) ([bcf9263](https://github.com/kavo-labs/kavo/commit/bcf9263))


### CI

- run autoformat workflow on push to main too ([#292](https://github.com/kavo-labs/kavo/issues/292)) ([8a37643](https://github.com/kavo-labs/kavo/commit/8a37643))

## [0.14.5](https://github.com/kavo-labs/kavo/compare/v0.14.4...v0.14.5) (2026-08-24)


### Bug Fixes

- **typeorm, prisma, mongoose, mikroorm:** treat undefined-valued patch keys as absent ([1d2a026](https://github.com/kavo-labs/kavo/commit/1d2a026))

## [0.14.4](https://github.com/kavo-labs/kavo/compare/v0.14.3...v0.14.4) (2026-08-24)


### Features

- **core:** add PatchNoChangesException ([696dcf2](https://github.com/kavo-labs/kavo/commit/696dcf2))

## [0.14.3](https://github.com/kavo-labs/kavo/compare/v0.14.2...v0.14.3) (2026-08-24)


### Bug Fixes

- **nest:** relax patchOne's entity-fallback DTO to optional fields ([f11f4fa](https://github.com/kavo-labs/kavo/commit/f11f4fa))

## [0.14.2](https://github.com/kavo-labs/kavo/compare/v0.14.1...v0.14.2) (2026-08-24)


### Bug Fixes

- **nest:** fall back an unregistered write DTO to a validated entity class ([900f41d](https://github.com/kavo-labs/kavo/commit/900f41d))

## [0.14.1](https://github.com/kavo-labs/kavo/compare/v0.14.0...v0.14.1) (2026-08-24)


### Bug Fixes

- **nest:** validate dto.create/update/patch on generated routes, not just @Override()'d ones ([c0ff232](https://github.com/kavo-labs/kavo/commit/c0ff232))


### Tests

- **typeorm:** add N+1 query-count regression guard; document test coverage roadmap ([fd93dd9](https://github.com/kavo-labs/kavo/commit/fd93dd9))
- **examples:** add concurrent-write race coverage over real HTTP + SQLite ([61a9dba](https://github.com/kavo-labs/kavo/commit/61a9dba))
- **examples:** add attacker-controlled-input security suites across all three example apps ([8af639b](https://github.com/kavo-labs/kavo/commit/8af639b))

## [0.14.0](https://github.com/kavo-labs/kavo/compare/v0.13.0...v0.14.0) (2026-08-24)


### Bug Fixes

- **typeorm:** map invalid-uuid driver errors to a 400, not KAVO_PERSISTENCE_FAILED ([e493638](https://github.com/kavo-labs/kavo/commit/e493638))


### Documentation

- **adr:** extend composite primary key scope to @kavo/prisma ([#270](https://github.com/kavo-labs/kavo/issues/270)) ([75e6f5d](https://github.com/kavo-labs/kavo/commit/75e6f5d))


### CI

- add Dependabot config for npm and github-actions updates ([#272](https://github.com/kavo-labs/kavo/issues/272)) ([6ccbfe4](https://github.com/kavo-labs/kavo/commit/6ccbfe4))
- add autoformat bot to push formatting fixes on PRs ([#271](https://github.com/kavo-labs/kavo/issues/271)) ([df48a74](https://github.com/kavo-labs/kavo/commit/df48a74))

## [0.13.0](https://github.com/kavo-labs/kavo/compare/v0.12.0...v0.13.0) (2026-08-22)


### Features

- **core:** add creatable/updatable allowlists to constrain writable fields ([ab70bb7](https://github.com/kavo-labs/kavo/commit/ab70bb7))
- **core, typeorm:** support composite primary keys ([96e581d](https://github.com/kavo-labs/kavo/commit/96e581d))
- **nest:** fall back to synthesized Swagger schemas from creatable/updatable/selectable ([20e172c](https://github.com/kavo-labs/kavo/commit/20e172c))

## [0.12.0](https://github.com/kavo-labs/kavo/compare/v0.11.0...v0.12.0) (2026-08-21)


### ⚠ BREAKING CHANGES

- **core:** declared `operations` config is now an explicit whitelist — an operation absent from the map is disabled.

### Features

- **core:** make declared operations config an explicit whitelist ([2f73384](https://github.com/kavo-labs/kavo/commit/2f73384))
- exclude id and soft-delete marker from default writable projection ([#256](https://github.com/kavo-labs/kavo/issues/256)) ([8aa8d65](https://github.com/kavo-labs/kavo/commit/8aa8d65))


### Bug Fixes

- remove redundant realtime.enabled — `realtime: false` already means disabled ([#254](https://github.com/kavo-labs/kavo/issues/254)) ([6c401a9](https://github.com/kavo-labs/kavo/commit/6c401a9))


### Refactoring

- **core:** simplify cache.etag to a plain boolean ([b34be7e](https://github.com/kavo-labs/kavo/commit/b34be7e))

## [0.11.0](https://github.com/kavo-labs/kavo/compare/v0.10.0...v0.11.0) (2026-08-20)


### Features

- **core:** add entity- and global-scope policy defaults ([c6b16ec](https://github.com/kavo-labs/kavo/commit/c6b16ec))


### Refactoring

- **core:** policy collapses to a single predicate function ([#252](https://github.com/kavo-labs/kavo/issues/252)) ([abddc25](https://github.com/kavo-labs/kavo/commit/abddc25))

## [0.10.0](https://github.com/kavo-labs/kavo/compare/v0.9.0...v0.10.0) (2026-08-20)


### ⚠ BREAKING CHANGES

- **core:** new `search[query]` / `search[mode]` / `search[fields]` query grammar replaces the previous search params.
- **core:** `include=` permission moves from a standalone option into `allowlists.includable`.

### Features

- **core:** add a policy authorization DSL and engine enforcement stage ([49e976e](https://github.com/kavo-labs/kavo/commit/49e976e))
- **core:** add filtered() policy node ([d42e597](https://github.com/kavo-labs/kavo/commit/d42e597))
- **core:** add authorization.required default-deny switch ([fe198e8](https://github.com/kavo-labs/kavo/commit/fe198e8))
- **core:** TTL result cache for findOne/findMany ([#233](https://github.com/kavo-labs/kavo/issues/233)) ([43f6af7](https://github.com/kavo-labs/kavo/commit/43f6af7))
- **core:** add search[query]/search[mode]/search[fields] query grammar ([408dfac](https://github.com/kavo-labs/kavo/commit/408dfac))
- **core:** move include= permission into allowlists.includable ([479d762](https://github.com/kavo-labs/kavo/commit/479d762))
- **nest:** add getResource/getOperation route identity helpers ([#238](https://github.com/kavo-labs/kavo/issues/238)) ([92e3e28](https://github.com/kavo-labs/kavo/commit/92e3e28))
- **core, nest, examples:** add a 'none' pagination strategy to opt a resource out entirely ([#225](https://github.com/kavo-labs/kavo/issues/225)) ([79c2d04](https://github.com/kavo-labs/kavo/commit/79c2d04))
- **core, nest, typeorm:** array-relation mutation — replace and jsonPatch strategies (ADR-0029) ([fa43998](https://github.com/kavo-labs/kavo/commit/fa43998), [7618c4e](https://github.com/kavo-labs/kavo/commit/7618c4e))
- **core, nest:** make arrayMutation.strategy a per-relation choice, stop defaulting it to "replace" ([#222](https://github.com/kavo-labs/kavo/issues/222)) ([f26c6cd](https://github.com/kavo-labs/kavo/commit/f26c6cd))
- **examples/nest-typeorm:** add a class-validator validation layer ([#228](https://github.com/kavo-labs/kavo/issues/228)) ([e378ec1](https://github.com/kavo-labs/kavo/commit/e378ec1))


### Bug Fixes

- **core:** name both causes in the cursor advance guard, and rule out the sqlite date sort key ([3a7c546](https://github.com/kavo-labs/kavo/commit/3a7c546))
- **nest:** omit the Swagger include query param when nothing is includable ([c951a8b](https://github.com/kavo-labs/kavo/commit/c951a8b))
- **nest:** defer conditional-request Swagger docs until the global caching.etag scope resolves ([7845880](https://github.com/kavo-labs/kavo/commit/7845880))


### Refactoring

- **core:** when() policy predicate takes a single object argument; require PolicyNode, drop array shorthand ([4379c97](https://github.com/kavo-labs/kavo/commit/4379c97))
- **core:** remove EntityConfig.policy, require operations.<id>.policy ([ce222e5](https://github.com/kavo-labs/kavo/commit/ce222e5))
- **core:** compute the result-cache key once per request ([651d67a](https://github.com/kavo-labs/kavo/commit/651d67a))


### Documentation

- restructure and simplify the docs site; IA reorg, llms.txt, and a policy authorization reference ([07a4e2d](https://github.com/kavo-labs/kavo/commit/07a4e2d))
- add Contributor Covenant code of conduct ([#226](https://github.com/kavo-labs/kavo/issues/226)) ([fcc5dc2](https://github.com/kavo-labs/kavo/commit/fcc5dc2))

## [0.9.0](https://github.com/kavo-labs/kavo/compare/v0.8.0...v0.9.0) (2026-08-10)


### ⚠ BREAKING CHANGES

- **core:** `allowlists.selectable` now narrows the response projection, not just the `select=` param.

### Features

- **core:** allowlists.selectable narrows the response projection ([#188](https://github.com/kavo-labs/kavo/issues/188)) ([f39ef67](https://github.com/kavo-labs/kavo/commit/f39ef67))


### Bug Fixes

- **core:** refuse a custom operation result the entity projection empties ([#190](https://github.com/kavo-labs/kavo/issues/190)) ([17260e4](https://github.com/kavo-labs/kavo/commit/17260e4))
- **nest:** give an @Override'd route the ETag a generated one carries ([#189](https://github.com/kavo-labs/kavo/issues/189)) ([9dfc8b8](https://github.com/kavo-labs/kavo/commit/9dfc8b8))

## [0.8.0](https://github.com/kavo-labs/kavo/compare/v0.7.2...v0.8.0) (2026-08-10)


### ⚠ BREAKING CHANGES

- **core:** a handler now receives its entity's repository on the request context.
- **core, nest:** `EntityConfig.operations` may declare a custom operation id.

### Features

- **core:** give a handler its entity's repository on the request context ([#172](https://github.com/kavo-labs/kavo/issues/172)) ([14ca6ad](https://github.com/kavo-labs/kavo/commit/14ca6ad))
- **core, nest:** let EntityConfig.operations declare a custom operation id ([#151](https://github.com/kavo-labs/kavo/issues/151)) ([38c0f14](https://github.com/kavo-labs/kavo/commit/38c0f14))
- **core:** add a transport-agnostic realtime event seam ([#157](https://github.com/kavo-labs/kavo/issues/157)) ([a208ce6](https://github.com/kavo-labs/kavo/commit/a208ce6))
- **realtime:** add @kavo/sse — the first RealtimeTransport implementation ([a04ab6f](https://github.com/kavo-labs/kavo/commit/a04ab6f))
- **realtime:** add collection-level and filtered subscriptions ([13fb609](https://github.com/kavo-labs/kavo/commit/13fb609))
- **nest:** add realtimeTransports pass-through + wire @kavo/sse into the nest-typeorm example ([94331be](https://github.com/kavo-labs/kavo/commit/94331be))


### Refactoring

- **sse:** rename createSseTransport to createTransport ([736c1d4](https://github.com/kavo-labs/kavo/commit/736c1d4))


### Documentation

- add a realtime section to the homepage and animate a request/SSE flow diagram ([#167](https://github.com/kavo-labs/kavo/issues/167)) ([88af7d8](https://github.com/kavo-labs/kavo/commit/88af7d8))

## [0.7.2](https://github.com/kavo-labs/kavo/compare/v0.7.1...v0.7.2) (2026-08-07)


### Bug Fixes

- **nest:** resolve KavoContext.principal from the request on generated routes ([#147](https://github.com/kavo-labs/kavo/issues/147)) ([9edaa8e](https://github.com/kavo-labs/kavo/commit/9edaa8e))


### Tests

- close the measured coverage gaps and gate coverage in CI ([#143](https://github.com/kavo-labs/kavo/issues/143)) ([a42f16e](https://github.com/kavo-labs/kavo/commit/a42f16e))

## [0.7.1](https://github.com/kavo-labs/kavo/compare/v0.6.0...v0.7.1) (2026-08-06)


### ⚠ BREAKING CHANGES

- **core, typeorm, prisma, mongoose, mikroorm:** cursor (keyset) pagination changes the pagination wire contract.
- **core:** the list envelope's `meta` is now populated from the findMany handler.

### Features

- **mikroorm:** add @kavo/mikroorm adapter with parity to @kavo/typeorm ([#104](https://github.com/kavo-labs/kavo/issues/104)) ([557a15f](https://github.com/kavo-labs/kavo/commit/557a15f))
- **mongoose:** add the @kavo/mongoose adapter package ([#65](https://github.com/kavo-labs/kavo/issues/65)) ([926746b](https://github.com/kavo-labs/kavo/commit/926746b))
- **mcp:** add @kavo/mcp protocol package exposing entities as MCP tools ([3e21a32](https://github.com/kavo-labs/kavo/commit/3e21a32))
- **core, typeorm, prisma, mongoose, mikroorm:** cursor (keyset) pagination ([#129](https://github.com/kavo-labs/kavo/issues/129)) ([8709b6d](https://github.com/kavo-labs/kavo/commit/8709b6d))
- **core:** add `since` (seek-by-timestamp) pagination strategy ([b9a9eab](https://github.com/kavo-labs/kavo/commit/b9a9eab))
- **core, nest:** ETag response caching and If-Match preconditions ([#128](https://github.com/kavo-labs/kavo/issues/128)) ([9e4a551](https://github.com/kavo-labs/kavo/commit/9e4a551))
- **core:** add computed/virtual fields to entity responses ([#127](https://github.com/kavo-labs/kavo/issues/127)) ([c67138d](https://github.com/kavo-labs/kavo/commit/c67138d))
- **core:** populate the list envelope's meta from the findMany handler ([#126](https://github.com/kavo-labs/kavo/issues/126)) ([bf77f34](https://github.com/kavo-labs/kavo/commit/bf77f34))
- **core, nest:** allow per-operation DTO overrides (input/output/query) ([ff8ea46](https://github.com/kavo-labs/kavo/commit/ff8ea46))
- **core, nest:** error-message quality pass ([#123](https://github.com/kavo-labs/kavo/issues/123)) ([0755065](https://github.com/kavo-labs/kavo/commit/0755065))
- **core:** add onlyDeleted query param to filter reads to only soft-deleted records ([a00a68d](https://github.com/kavo-labs/kavo/commit/a00a68d))
- **core:** add configurable default sort order to getMany/list queries ([b2debff](https://github.com/kavo-labs/kavo/commit/b2debff))
- **nest-typeorm:** add CockroachDB flavour to the example app ([#107](https://github.com/kavo-labs/kavo/issues/107)) ([fa0c5b6](https://github.com/kavo-labs/kavo/commit/fa0c5b6))


### Bug Fixes

- **core, nest:** apply application/problem+json to every error, not just KavoException ([2b57101](https://github.com/kavo-labs/kavo/commit/2b57101))
- **core, typeorm, prisma, mongoose, mikroorm:** five query-grammar correctness bugs ([#117](https://github.com/kavo-labs/kavo/issues/117)) ([6c9d2b2](https://github.com/kavo-labs/kavo/commit/6c9d2b2))
- **core:** stop a __proto__ bracket segment polluting Object.prototype ([#112](https://github.com/kavo-labs/kavo/issues/112)) ([9a96a9c](https://github.com/kavo-labs/kavo/commit/9a96a9c))


### Refactoring

- **mcp:** rename tool ids to dotted <entity>.<op> form ([91501f4](https://github.com/kavo-labs/kavo/commit/91501f4))
- **orms:** rename createTypeOrmInfrastructure/createPrismaInfrastructure to createInfrastructure ([c818696](https://github.com/kavo-labs/kavo/commit/c818696))


### Documentation

- getting started + integrations guide, demote architecture/ADR docs ([5437eb4](https://github.com/kavo-labs/kavo/commit/5437eb4))
- document the full filter/query grammar in using-the-api ([15e35f4](https://github.com/kavo-labs/kavo/commit/15e35f4))
- add CONTRIBUTING.md covering setup, the gate, and PR invariants ([#82](https://github.com/kavo-labs/kavo/issues/82)) ([b026a9c](https://github.com/kavo-labs/kavo/commit/b026a9c))


### CI

- verify packed tarballs are installable before publishing ([#99](https://github.com/kavo-labs/kavo/issues/99)) ([10b59e6](https://github.com/kavo-labs/kavo/commit/10b59e6))
- enforce ADR-0004 lockstep versions before publishing ([#96](https://github.com/kavo-labs/kavo/issues/96)) ([818a7ef](https://github.com/kavo-labs/kavo/commit/818a7ef))
- build the docs site in CI so docs breakage gates the PR ([#95](https://github.com/kavo-labs/kavo/issues/95)) ([7914ff5](https://github.com/kavo-labs/kavo/commit/7914ff5))

## [0.6.0](https://github.com/kavo-labs/kavo/compare/v0.4.0...v0.6.0) (2026-08-01)


### ⚠ BREAKING CHANGES

- the `@Crud` decorator and its whole identifier family are renamed to `Kavo` / `@Kavo`.

### Features

- **prisma:** add @kavo/prisma adapter package ([92622a0](https://github.com/kavo-labs/kavo/commit/92622a0))
- **docs:** redesign the homepage with an animated hero theme ([a70d611](https://github.com/kavo-labs/kavo/commit/a70d611))


### Bug Fixes

- **prisma:** close review findings from PR [#53](https://github.com/kavo-labs/kavo/issues/53) ([56882d5](https://github.com/kavo-labs/kavo/commit/56882d5))
- **docs:** correct the vitepress base path for the custom domain ([fe1138a](https://github.com/kavo-labs/kavo/commit/fe1138a))


### Refactoring

- **core, nest, graphql:** rename the Crud identifier family to Kavo ([6e3e64c](https://github.com/kavo-labs/kavo/commit/6e3e64c))


### Documentation

- document the Prisma adapter ([13fcb7e](https://github.com/kavo-labs/kavo/commit/13fcb7e))

## [0.4.0](https://github.com/kavo-labs/kavo/compare/v0.3.0...v0.4.0) (2026-07-31)


### Features

- **skills:** package the developer skills as a Claude Code plugin ([ae365c2](https://github.com/kavo-labs/kavo/commit/ae365c2))


### Documentation

- add a VitePress site over packages/docs ([be44ac3](https://github.com/kavo-labs/kavo/commit/be44ac3))
- add a swagger skill and quick-start step ([24bb527](https://github.com/kavo-labs/kavo/commit/24bb527))


### Tests

- **nest:** cover GraphQL list query pagination and filter/sort over HTTP ([bcddc53](https://github.com/kavo-labs/kavo/commit/bcddc53))


### CI

- deploy the docs site to GitHub Pages ([8a2d6d8](https://github.com/kavo-labs/kavo/commit/8a2d6d8))

## [0.3.0](https://github.com/kavo-labs/kavo/compare/v0.2.0...v0.3.0) (2026-07-30)


### Features

- **graphql:** add @kavo/graphql — host-agnostic GraphQL schema binding ([00707ed](https://github.com/kavo-labs/kavo/commit/00707ed))
- **nest:** GraphQL binding integration — discovery, base controller, zero-config route ([638f5a5](https://github.com/kavo-labs/kavo/commit/638f5a5))
- **core:** support the { exclude } shape in query allowlists ([e996c23](https://github.com/kavo-labs/kavo/commit/e996c23))


### Bug Fixes

- **nest:** lazy-load @kavo/graphql so it stays a truly optional peer ([0af8d40](https://github.com/kavo-labs/kavo/commit/0af8d40))


### Documentation

- record ADR-0016 and document the GraphQL binding ([e1a1d6c](https://github.com/kavo-labs/kavo/commit/e1a1d6c))
- add developer-facing Kavo usage skills ([98c523c](https://github.com/kavo-labs/kavo/commit/98c523c))

## [0.2.0](https://github.com/kavo-labs/kavo/compare/v0.1.1...v0.2.0) (2026-07-30)


### ⚠ BREAKING CHANGES

- **core:** `customOperations` is removed from `EntityConfig`.

### Features

- **core:** add global operations defaults ([#39](https://github.com/kavo-labs/kavo/issues/39)) ([e7b1e81](https://github.com/kavo-labs/kavo/commit/e7b1e81))
- **nest:** auto-discover @Crud controllers, no forFeature required ([3d495cc](https://github.com/kavo-labs/kavo/commit/3d495cc))
- **nest:** support controller-method overrides via @Override ([3798cc3](https://github.com/kavo-labs/kavo/commit/3798cc3))
- **nest:** auto-wire WireQuery for @Override'd read operations ([bfc0f2c](https://github.com/kavo-labs/kavo/commit/bfc0f2c))
- **examples:** add a Postgres example alongside the SQLite reference app ([7c9bf49](https://github.com/kavo-labs/kavo/commit/7c9bf49))


### Bug Fixes

- **typeorm:** use softRemove/recover for soft-delete lifecycle hooks ([1b47add](https://github.com/kavo-labs/kavo/commit/1b47add))
- **workflows:** make npm publish steps idempotent on retry ([0c05e0a](https://github.com/kavo-labs/kavo/commit/0c05e0a))


### Performance

- **typeorm:** drop patch/update's redundant preload SELECT ([9fac725](https://github.com/kavo-labs/kavo/commit/9fac725))


### Refactoring

- **core:** remove customOperations from EntityConfig ([0ecd815](https://github.com/kavo-labs/kavo/commit/0ecd815))


### Documentation

- document the eager-loading pattern for detail views ([#35](https://github.com/kavo-labs/kavo/issues/35)) ([e67e2dd](https://github.com/kavo-labs/kavo/commit/e67e2dd))
- sync ADR-0012, the NestJS integration doc, and CLAUDE.md with auto-discovery ([5fcf59d](https://github.com/kavo-labs/kavo/commit/5fcf59d))


### CI

- create a GitHub Release alongside every npm publish ([#20](https://github.com/kavo-labs/kavo/issues/20)) ([ceb5200](https://github.com/kavo-labs/kavo/commit/ceb5200))

## [0.1.1](https://github.com/kavo-labs/kavo/compare/v0.1.0...v0.1.1) (2026-07-26)


### Documentation

- **readme:** add npm install instructions ([2bfc2f6](https://github.com/kavo-labs/kavo/commit/2bfc2f6))

## 0.1.0 (2026-07-26)


### Features

- **core:** add core CRUD contracts, config, query, and persistence layer ([4f8477f](https://github.com/kavo-labs/kavo/commit/4f8477f))
- **core:** implement the CRUD engine runtime ([55d8c3b](https://github.com/kavo-labs/kavo/commit/55d8c3b))
- **core:** infer DTO and query input types without generics, and gate tests with tsc ([ea3b187](https://github.com/kavo-labs/kavo/commit/ea3b187))
- **core:** resolve relation includes into a validated tree ([1cf2202](https://github.com/kavo-labs/kavo/commit/1cf2202))
- **core:** resolve the delete strategy and bind restore/purge ([25c8339](https://github.com/kavo-labs/kavo/commit/25c8339))
- **typeorm:** implement the TypeORM repository adapter ([2f17337](https://github.com/kavo-labs/kavo/commit/2f17337))
- **typeorm:** implement soft delete, restore, and purge ([34c3baa](https://github.com/kavo-labs/kavo/commit/34c3baa))
- **typeorm:** load includes by join and batch ([d280f04](https://github.com/kavo-labs/kavo/commit/d280f04))
- **nest:** implement the @Crud decorator and CrudoModule ([ea5a527](https://github.com/kavo-labs/kavo/commit/ea5a527))
- **nest:** add Swagger schema hints for enum and oneOf fields ([fac208a](https://github.com/kavo-labs/kavo/commit/fac208a))
- **examples:** add a Milestone B checkpoint app with an e2e suite ([1b50ec2](https://github.com/kavo-labs/kavo/commit/1b50ec2))


### Bug Fixes

- **typeorm:** translate every filter operator or fail loudly ([31b91f5](https://github.com/kavo-labs/kavo/commit/31b91f5))
- **typeorm:** resolve relation targets to the entity class ([1e00483](https://github.com/kavo-labs/kavo/commit/1e00483))
- **nest:** document Swagger request/response schemas from the DTO shape ([e5187fe](https://github.com/kavo-labs/kavo/commit/e5187fe))


### Refactoring

- **core:** drop the optional bulk surface ([67468a1](https://github.com/kavo-labs/kavo/commit/67468a1))


### Documentation

- add architecture docs, ADRs, and a glossary ([cf5cb77](https://github.com/kavo-labs/kavo/commit/cf5cb77))
- document relations and includes (ADR-0014) ([284ee02](https://github.com/kavo-labs/kavo/commit/284ee02))
- document soft delete (ADR-0013) ([cde52c6](https://github.com/kavo-labs/kavo/commit/cde52c6))
