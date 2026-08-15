/**
 * @kavo/core — framework- and ORM-independent contracts and type system.
 *
 * This barrel is an **explicit named list**, kept deliberately (no
 * `export *`): the public surface should only ever change on purpose, the
 * future api-extractor gate diffs against it, and module
 * augmentation of `OperationMetadata` needs a stable module to target.
 */

// ── Foundational types ────────────────────────────────────────────────
export type { EntityId } from "./types/entity-id.js";
export type { FieldPath, FieldPathDepth } from "./types/field-path.js";
export type { IncludePath } from "./types/include-path.js";
export type { ClassRef, DeepPartial, EntityInput, IsAny, IsUnknown, Primitive, ScalarKeys } from "./types/utility.js";

// ── Query model ───────────────────────────────────────────────────────
export type {
  FilterExpression,
  FilterOperator,
  FilterScalar,
  FilterValue,
  Filter,
  FilterCondition,
  FilterGroup,
  LogicalOperator,
} from "./query/filter.js";
export type {
  Pagination,
  OffsetPagination,
  CursorPagination,
  SincePagination,
  PaginationLimits,
  PaginationStrategy,
} from "./query/pagination.js";
export { isCursorPagination, isSincePagination, hasKeyset } from "./query/pagination.js";
// `decodeCursor` and `keysetExpression` are deliberately *not* exported:
// they are `QueryNormalizer` internals whose contracts only hold when the
// effective sort has already been validated, and the barrel is an explicit
// public surface (ADR-0010). Adapters need `readFilter`/`isCursorPagination`/
// `isSincePagination`/`hasKeyset`; a custom `findMany` handler needs
// `encodeCursor`/`cursorValuesOf` (cursor) or `sinceValueOf` (since,
// ADR-0022).
export { encodeCursor, cursorValuesOf, readFilter } from "./query/cursor.js";
export { sinceValueOf } from "./query/since.js";
export type { Sort, SortDirection } from "./query/sort.js";
export type { FieldSelection, FieldSelectionInput } from "./query/field-selection.js";
export type { NormalizedQueryContext, QueryContext } from "./query/query-context.js";
export type { FilterParser } from "./query/filter-parser.js";
export type { FilterBuilder } from "./query/filter-builder.js";
export { evaluateFilter } from "./query/filter-evaluator.js";

// ── DTO system ────────────────────────────────────────────────────────
export type {
  DtoClass,
  DtoSlot,
  Dto,
  DtoResolver,
  OperationDtoMap,
  OperationDtoOverride,
  DtoInputOf,
  DtoOutputOf,
  DtoQueryOf,
} from "./dto/dto.js";
export type { ListMetaDto, ListResultDto } from "./dto/list-result.js";

// ── Errors ────────────────────────────────────────────────────────────
export type { KavoErrorCode, KavoExceptionShape, ErrorContext, ErrorHandler } from "./errors/kavo-exception-shape.js";
export type { ProblemDetailsDto, QueryIssueDto } from "./errors/problem-details.js";

// ── Configuration ─────────────────────────────────────────────────────
export type {
  KavoSettings,
  CachingSettings,
  ErrorSettings,
  PaginationSettings,
  QuerySettings,
  RealtimeFieldSelector,
  RealtimeSettings,
  RelationEdgeSettings,
  RelationSettings,
  SearchDriver,
  SearchMode,
  SearchSettings,
  SoftDeleteMode,
  SoftDeleteSettings,
  PaginationStrategyName,
} from "./config/settings.js";
export type { GlobalConfig } from "./config/global-config.js";
export type {
  CustomOperationConfig,
  EntityConfig,
  OperationConfig,
  OperationsConfig,
  StandardOperationsConfig,
  QueryAllowlists,
  QueryFieldSelector,
  RelationFieldSelector,
} from "./config/entity-config.js";
export type { ComputedFieldDescriptor, ComputedFieldMap } from "./config/computed-field.js";
export type { ResolvedEntityConfig, ResolvedQueryAllowlists } from "./config/resolved-entity-config.js";

// ── Realtime ──────────────────────────────────────────────────────────
export type { RealtimeEventDto, RealtimeEventId } from "./realtime/realtime-event.js";
export type { RealtimeTransport } from "./realtime/realtime-transport.js";

// ── Operations ────────────────────────────────────────────────────────
export type { OperationCardinality, OperationId, OperationKind, StandardOperationId } from "./operations/operation.js";
export type { OperationHandler, OperationMetadata } from "./operations/operation-handler.js";
export type { OperationDescriptor, OperationRegistry } from "./operations/operation-registry.js";

// ── Relations & includes ──────────────────────────────────────────────
export type { RelationDescriptor, RelationCardinality, RelationLoadStrategy } from "./relations/relation-descriptor.js";
export type { RelationRegistry } from "./relations/relation-registry.js";
export type { IncludeNode, IncludeTree } from "./relations/include-tree.js";
export type { IncludeRequest, IncludeResolver } from "./relations/include-resolver.js";
export { DefaultIncludeResolver } from "./relations/default-include-resolver.js";
// `arrayMutation`'s `replace`/`resource` strategies (ADR-0014, ADR-0029's
// resource amendment): `@kavo/nest`'s decorator needs these to generate the
// same registry entries and sub-collection routes `createCrud` builds
// (ADR-0013).
export type { ArrayMutationAction, ArrayMutationHandlerFactories } from "./relations/array-mutation-operations.js";
export {
  addRelationOperationId,
  listRelationOperationId,
  registerArrayMutationOperations,
  removeRelationOperationId,
  replaceRelationOperationId,
  writeOptedInRelationNames,
} from "./relations/array-mutation-operations.js";

// ── Request context & envelopes ───────────────────────────────────────
export type { KavoContext, KavoContextState, StateKey } from "./context/kavo-context.js";
export type { KavoRequest } from "./context/kavo-request.js";
export type { KavoResponse } from "./context/kavo-response.js";

// ── HTTP caching (ADR-0020) ───────────────────────────────────────────
// `computeEtag` was held back while nothing in the workspace needed it —
// `@kavo/nest` read the tag off `KavoResponse` and that was enough. It is
// no longer enough: an `@Override`'d route that returns the typed service's
// unwrapped item has no envelope to read a tag from, so the binding has to
// compute one itself or let the host framework's weak default stand in for
// Kavo's (ADR-0027). That is a consumer, which is the bar ADR-0010 sets.
//
// What the export promises is "the tag Kavo would set for this
// representation", not the algorithm behind it — so ADR-0020's option to
// supersede the content hash with a version column stays open.
export { computeEtag } from "./caching/etag.js";
export type { RequestPreconditions } from "./caching/etag.js";

// ── Serialization ─────────────────────────────────────────────────────
export type { Deserializer, Serializer } from "./serialization/serializer.js";

// ── Persistence ───────────────────────────────────────────────────────
export type { EntityReader } from "./persistence/entity-reader.js";
export type { EntityWriter } from "./persistence/entity-writer.js";
export type { RepositoryAdapter } from "./persistence/repository-adapter.js";
export type { DeleteStrategy, ResolvedSoftDelete, SoftDeletable } from "./persistence/soft-delete.js";
export type {
  TransactionContext,
  TransactionManager,
  TransactionOptions,
  TransactionPropagation,
} from "./persistence/transaction-manager.js";

// ── Service surface ───────────────────────────────────────────────────
export type { KavoCallOptions } from "./service/kavo-call-options.js";
export type { KavoService } from "./service/kavo-service.js";
export type {
  CustomOperationBody,
  CustomOperationId,
  CustomOperationRequest,
  CustomOperationResult,
} from "./service/custom-operation.js";

// ════════════════════════════════════════════════════════════════════
// Runtime — implementations of the contracts above.
// ════════════════════════════════════════════════════════════════════

// ── Type-system guards ────────────────────────────────────────────────
export { assertNever } from "./types/assert-never.js";

// ── Entity metadata seam ──────────────────────────────────────────────
export type { KavoInfrastructure, EntityMetadata, FieldKind, FieldMetadata } from "./metadata/entity-metadata.js";
export {
  DefaultEntityCatalog,
  type EntityCatalog,
  type EntityRuntimeInfo,
  type MetadataSource,
} from "./metadata/entity-catalog.js";

// ── Errors ────────────────────────────────────────────────────────────
export {
  ERROR_CATALOG,
  renderMessage,
  type CatalogedErrorCode,
  type ErrorCatalogEntry,
} from "./errors/error-catalog.js";
export {
  AlreadyDeletedException,
  ArrayMutationInvalidShapeException,
  ArrayMutationMemberNotFoundException,
  ConfigurationException,
  ConflictException,
  JsonPatchInvalidDocumentException,
  JsonPatchTargetNotFoundException,
  KavoException,
  NotDeletedException,
  NotFoundException,
  OperationDisabledException,
  OperationNotRegisteredException,
  PersistenceException,
  PreconditionFailedException,
  PreconditionUnsupportedException,
  QueryValidationException,
  TransactionException,
  type KavoExceptionOptions,
} from "./errors/exceptions.js";
export { toProblemDetails, type ProblemDetailsOptions } from "./errors/problem-details-serializer.js";
export { DefaultErrorHandler } from "./errors/default-error-handler.js";

// ── Configuration runtime ─────────────────────────────────────────────
export { BUILT_IN_DEFAULTS } from "./config/defaults.js";
export { deepFreeze, mergeSettings } from "./config/merge-settings.js";
export { validateSettings } from "./config/validate-settings.js";
export { describeResolvedConfig, resolveEntityConfig } from "./config/resolve-entity-config.js";
export { HARD_DELETE, resolveSoftDelete } from "./persistence/soft-delete.js";

// ── DTO & serialization runtime ───────────────────────────────────────
export { DefaultDtoResolver } from "./dto/default-dto-resolver.js";
export { dtoShapeKeys } from "./dto/dto-shape.js";
export { DefaultDeserializer, DefaultSerializer } from "./serialization/default-serializer.js";

// ── Query runtime ─────────────────────────────────────────────────────
export { DefaultFilterParser } from "./query/default-filter-parser.js";
export {
  OffsetPaginationStrategy,
  PagePaginationStrategy,
  CursorPaginationStrategy,
  SincePaginationStrategy,
  builtInPaginationStrategies,
} from "./query/pagination-strategies.js";
export { QueryNormalizer } from "./query/query-normalizer.js";
export { parseBracketKey } from "./query/bracket-notation.js";

// ── Operations & engine runtime ───────────────────────────────────────
export {
  DefaultOperationRegistry,
  STANDARD_OPERATIONS,
  createOperationRegistry,
  type StandardHandlerFactory,
} from "./operations/default-operation-registry.js";
export { builtInHandlers, type FindManyResult, type IdentifiedWrite } from "./engine/built-in-handlers.js";
export { withListMeta, type ListMetaContributor } from "./engine/with-list-meta.js";
export { KavoEngine, WireQuery, type KavoEngineDependencies } from "./engine/kavo-engine.js";
export { DefaultKavoContextState, createKavoContext, type KavoContextInit } from "./context/default-kavo-context.js";
export { DefaultRelationRegistry } from "./relations/default-relation-registry.js";

// ── Service & root factory ────────────────────────────────────────────
export { DefaultKavoService } from "./service/default-kavo-service.js";
export { createCrud, createKavo, type KavoRuntime, type KavoInstance, type KavoOptions } from "./kavo.js";
