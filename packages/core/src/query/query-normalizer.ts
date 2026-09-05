import type { FieldSelection, FieldSelectionInput } from "./field-selection.js";
import type { Filter, FilterCondition, FilterExpression, FilterScalar } from "./filter.js";
import type { NormalizedQueryContext, QueryContext } from "./query-context.js";
import type { CursorPagination, Pagination, PaginationStrategy, SincePagination } from "./pagination.js";
import type { Sort } from "./sort.js";
import type { FieldPath } from "../types/field-path.js";
import type { ResolvedEntityConfig } from "../config/resolved-entity-config.js";
import type { EntityMetadata, FieldMetadata } from "../metadata/entity-metadata.js";
import type { QueryIssueDto } from "../errors/problem-details.js";
import type { IncludeResolver } from "../relations/include-resolver.js";
import type { IncludeTree } from "../relations/include-tree.js";
import type { AllowlistUsage } from "../errors/message-hints.js";
import { ConfigurationException, QueryValidationException } from "../errors/exceptions.js";
import { pushAllowlistIssue } from "../errors/message-hints.js";
import { DefaultFilterParser } from "./default-filter-parser.js";
import { NONE_PAGINATION_LIMIT, builtInPaginationStrategies } from "./pagination-strategies.js";
import { isCursorPagination, isSincePagination } from "./pagination.js";
import { decodeCursor, keysetExpression } from "./cursor.js";
import { decodeCompositeId } from "../metadata/composite-id.js";
import { coerceScalar, isIssue } from "./value-coercion.js";
import { parseBracketKey } from "./bracket-notation.js";

/**
 * The normalization pipeline: raw query string → validated →
 * `NormalizedQueryContext`. Both entry points — wire params from the
 * framework layer and programmatic `QueryContext` input — funnel into the
 * same normalized shape, so the engine and adapters only ever see one
 * canonical, validated form.
 *
 * All issues from all sections (filter, sort, select, pagination,
 * unsupported params) are collected into a single
 * `QueryValidationException`, so a client fixes its request in one round
 * trip.
 */
export class QueryNormalizer<Entity = unknown> {
  private readonly filterParser: DefaultFilterParser<Entity>;
  private readonly strategies: ReadonlyMap<string, PaginationStrategy>;
  private readonly includeResolver: IncludeResolver<Entity> | null;
  private readonly metadata: EntityMetadata<Entity>;
  private readonly fields: ReadonlyMap<string, FieldMetadata>;

  constructor(
    metadata: EntityMetadata<Entity>,
    extraStrategies: readonly PaginationStrategy[] = [],
    includeResolver: IncludeResolver<Entity> | null = null,
  ) {
    this.filterParser = new DefaultFilterParser(metadata);
    this.includeResolver = includeResolver;
    this.metadata = metadata;
    this.fields = new Map(metadata.fields.map((field) => [field.name, field]));
    const strategies = new Map(builtInPaginationStrategies());
    for (const strategy of extraStrategies) {
      strategies.set(strategy.name, strategy);
    }
    this.strategies = strategies;
  }

  /** Normalize flat wire params (`filter[age][gte]=18&sort=-name&…`). */
  normalizeWire(
    rawParams: Readonly<Record<string, unknown>>,
    config: ResolvedEntityConfig<Entity>,
  ): NormalizedQueryContext<Entity> {
    const issues: QueryIssueDto[] = [];

    const withDeleted = parseSoftDeleteFlag("withDeleted", rawParams["withDeleted"], config, issues);
    const onlyDeleted = parseSoftDeleteFlag("onlyDeleted", rawParams["onlyDeleted"], config, issues);
    if (withDeleted && onlyDeleted) {
      issues.push(conflictingSoftDeleteFlagsIssue());
    }

    let filter: Filter<Entity> = { root: null };
    try {
      filter = this.filterParser.parse(rawParams, config);
    } catch (error) {
      collectIssues(error, issues);
    }
    filter = parseSearch(rawParams, filter, config, issues);

    const clientSort = parseSort(rawParams["sort"], config, issues);
    let sort = clientSort.length > 0 ? clientSort : config.sortDefault;
    const select: FieldSelection<Entity> = parseSelect(rawParams, config, issues);
    const include = this.resolveIncludes(parseIncludePaths(rawParams["include"], issues), select, config, issues);

    let pagination: Pagination<Entity> = { limit: 0, offset: 0 };
    try {
      // `PaginationStrategy.normalize` returns the non-generic `Pagination`,
      // so the entity parameter has to be reintroduced here. The cast is
      // sound because the only entity-typed member is `keyset`, and a
      // strategy always leaves it `null` — it sees neither the effective
      // sort nor the metadata needed to build one (ADR-0021 §4). Making
      // `PaginationStrategy` generic would push that parameter onto every
      // third-party strategy for no gain.
      pagination = this.strategyFor(config).normalize(rawParams, {
        defaultLimit: config.settings.pagination.defaultLimit,
        maxLimit: config.settings.pagination.maxLimit,
      }) as Pagination<Entity>;
    } catch (error) {
      collectIssues(error, issues);
    }
    // Keyset resolution runs *after* sort, not inside the strategy: a
    // strategy is handed raw params and limits alone, and widening its
    // signature to take sort and metadata would break every custom one
    // (ADR-0021).
    if (isCursorPagination(pagination)) {
      pagination = this.resolveKeyset(pagination, sort, config, issues);
    } else if (isSincePagination(pagination)) {
      const resolved = this.resolveSince(pagination, clientSort, config, issues);
      sort = resolved.sort;
      pagination = resolved.pagination;
    }
    // The wire and programmatic paths reject a keyset param under the wrong
    // strategy identically. Dropping it on the floor would hand back page 1
    // forever while the client believed it was paging (ADR-0021, extended
    // to `since` by ADR-0022).
    if (!isCursorPagination(pagination) && hasValue(rawParams["cursor"])) {
      issues.push(keysetParamUnsupportedIssue(config, "cursor"));
    }
    if (!isSincePagination(pagination) && hasValue(rawParams["since"])) {
      issues.push(keysetParamUnsupportedIssue(config, "since"));
    }

    if (issues.length > 0) {
      throw new QueryValidationException(issues, {
        context: { entityName: config.entityName },
      });
    }
    return {
      filter,
      sort,
      pagination,
      select,
      include,
      withDeleted,
      onlyDeleted,
      count: config.settings.pagination.count,
    };
  }

  /**
   * Normalize programmatic input (`userCrud.findMany({ … })`). Values are
   * already typed — no coercion — but allowlists and limits are enforced
   * identically: the security posture cannot be bypassed by calling the
   * service directly with strings that defeat `FieldPath` typing.
   */
  normalizeInput(
    query: QueryContext<Entity> | undefined,
    config: ResolvedEntityConfig<Entity>,
  ): NormalizedQueryContext<Entity> {
    const issues: QueryIssueDto[] = [];
    const input = query ?? {};
    const withDeleted = parseSoftDeleteFlag("withDeleted", input.withDeleted, config, issues);
    const onlyDeleted = parseSoftDeleteFlag("onlyDeleted", input.onlyDeleted, config, issues);
    if (withDeleted && onlyDeleted) {
      issues.push(conflictingSoftDeleteFlagsIssue());
    }

    const root = input.filter ?? null;
    if (root !== null) {
      validateExpression(root, config, issues);
    }

    const clientSort = input.sort ?? [];
    for (const entry of clientSort) {
      requireAllowlisted(entry.field as string, config, "sorting", issues);
    }
    let sort = clientSort.length > 0 ? clientSort : config.sortDefault;

    const { root: rootFields, relations: relationFields } = collapseFieldSelection<Entity>(input.select, issues);
    if (rootFields != null) {
      for (const field of rootFields) {
        requireAllowlisted(field as string, config, "selection", issues);
      }
    }
    const select: FieldSelection<Entity> = {
      root: rootFields,
      relations: relationFields,
    };
    const include = this.resolveIncludes(input.include ?? [], select, config, issues);

    const { defaultLimit, maxLimit, strategy } = config.settings.pagination;
    // `NonePaginationStrategy` (`pagination-strategies.ts`) is never invoked
    // here: unlike cursor/since, "none" has no wire shape of its own to
    // decode, and the programmatic path already knows its own `limit`/
    // `offset` field names, so there is nothing a strategy call would add.
    // This is the one place that has to know the strategy by name rather
    // than by the shape it produces — `paginationShape`'s probe cannot tell
    // "none" apart from "offset" structurally, since both produce a plain
    // `{ limit, offset }`. A deliberate, narrow exception to §4's
    // structural-not-name-based rule, not a reversal of it (ADR-0030).
    if (strategy === "none") {
      if (input.limit !== undefined) {
        issues.push(noneParamUnsupportedIssue(config, "limit"));
      }
      if (input.offset !== undefined) {
        issues.push(noneParamUnsupportedIssue(config, "offset"));
      }
    }
    const limit = strategy === "none" ? NONE_PAGINATION_LIMIT : Math.min(input.limit ?? defaultLimit, maxLimit);
    const offset = strategy === "none" ? 0 : (input.offset ?? 0);
    if (limit < 1 || offset < 0 || !Number.isInteger(limit) || !Number.isInteger(offset)) {
      issues.push({
        field: limit < 1 || !Number.isInteger(limit) ? "limit" : "offset",
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: `Pagination values must be integers (limit ≥ 1, offset ≥ 0).`,
      });
    }
    // The programmatic path does not run the strategy — its input is already
    // typed, so there is nothing to parse — but it must reach the *same*
    // normalized form, or calling the service directly would silently fall
    // back to offset paging on a cursor- or since-configured entity.
    const shape = this.paginationShape(config);
    // Absent *or empty* means "first page" — `hasValue` is the same
    // predicate the wire path applies, so a caller holding `nextCursor`/
    // `nextSince` in a string that starts out `""` does not get a 400 where
    // the equivalent `?cursor=`/`?since=` gets page one.
    const cursorToken = hasValue(input.cursor) ? (input.cursor as string) : null;
    const sinceToken = hasValue(input.since) ? (input.since as string) : null;
    if (cursorToken !== null && shape !== "cursor") {
      issues.push(keysetParamUnsupportedIssue(config, "cursor"));
    }
    if (sinceToken !== null && shape !== "since") {
      issues.push(keysetParamUnsupportedIssue(config, "since"));
    }

    let pagination: Pagination<Entity>;
    if (shape === "cursor") {
      pagination = this.resolveKeyset({ limit, cursor: cursorToken, keyset: null }, sort, config, issues);
    } else if (shape === "since") {
      const resolved = this.resolveSince({ limit, since: sinceToken, keyset: null }, clientSort, config, issues);
      sort = resolved.sort;
      pagination = resolved.pagination;
    } else {
      pagination = { limit, offset };
    }

    if (issues.length > 0) {
      throw new QueryValidationException(issues, {
        context: { entityName: config.entityName },
      });
    }
    return {
      filter: { root },
      sort,
      pagination,
      select,
      include,
      withDeleted,
      onlyDeleted,
      count: config.settings.pagination.count,
    };
  }

  /**
   * Enforce what cursor pagination needs from the effective sort, then
   * decode the token against it.
   *
   * Keyset paging is only correct over a **total** order, and
   * `EntityMetadata` carries no uniqueness information beyond `idField`
   * (composite keys are out of scope) — so "ends in a unique tiebreaker"
   * is read here as "ends in the primary key", the one field Kavo can prove
   * unique. The other two rules exist for the same reason: a relation path
   * has no value to read off the returned row, and a `json` column has no
   * portable ordering.
   *
   * Two allowlists beyond `sortable` gate the same set, because a cursor
   * sort key is not only sorted by (ADR-0021):
   *
   * - **`filterable`**, because `keysetExpression` mints `EQ`/`GT`/`LT`
   *   nodes over these fields and `readFilter` AND-s them into the adapter's
   *   filter *after* `DefaultFilterParser` and `validateExpression` have
   *   run. Without this check, `?sort=email,id&cursor=…` is a comparison
   *   oracle over a field the config declared non-filterable, reachable by
   *   binary search even though `?filter[email][gt]=…` is a 400.
   * - **`selectable`**, because `cursorValuesOf` reads the raw entity and
   *   `meta` never passes through the serializer, so the value lands in
   *   `meta.nextCursor` regardless of the item DTO. Excluding
   *   `passwordHash` from `selectable` while leaving `sortable` at its
   *   default would otherwise base64-encode the hash into every page token.
   *
   * The field is **rejected**, never silently dropped from the sort:
   * omitting a key would break the total order the keyset depends on.
   *
   * A *nullable* sort field is deliberately **not** rejected here. Whether
   * an ORM calls a column nullable is not a reliable signal (Mongoose
   * reports every non-`required` path that way), so rejecting on it would
   * make cursor paging unusable rather than safe. `decodeCursor` refuses a
   * `null` cursor value instead — which, as ADR-0021 §4 now records
   * plainly, is a *partial* guard: it catches NULLS-FIRST orderings and
   * does nothing for NULLS-LAST ones, where null-keyed rows are omitted
   * from every page without an error. Cursor paging is documented as
   * unsupported over a nullable sort key.
   */
  private resolveKeyset(
    pagination: CursorPagination<Entity>,
    sort: readonly Sort<Entity>[],
    config: ResolvedEntityConfig<Entity>,
    issues: QueryIssueDto[],
  ): CursorPagination<Entity> {
    // A composite key (issue #263) has no single unique field to end the
    // sort in — its full `compositeIdFields` tuple, in declaration order,
    // is the tiebreaker instead. `keysetExpression`/`decodeCursor` already
    // operate over the whole effective sort generically (an N-column
    // row-value comparison, not a single-field special case), so the only
    // thing this method has to generalize is what "ends in the tiebreaker"
    // means.
    const tiebreaker = this.metadata.compositeIdFields ?? [this.metadata.idField];
    const before = issues.length;
    for (const entry of sort) {
      const field = this.fields.get(entry.field as string);
      if (field === undefined) {
        issues.push(cursorSortIssue(entry.field as string, "is not a scalar column of this entity"));
        continue;
      }
      if (field.kind === "json") {
        issues.push(cursorSortIssue(field.name, "is a 'json' column, which has no portable ordering"));
        continue;
      }
      // The same gate the filter parser and the fieldset parser use, so the
      // cursor path cannot be the one way around an allowlist.
      if (requireAllowlisted(field.name, config, "filtering", issues)) {
        requireAllowlisted(field.name, config, "selection", issues);
      }
    }
    const tail = sort.slice(sort.length - tiebreaker.length).map((entry) => entry.field as string);
    if (sort.length < tiebreaker.length || !tiebreaker.every((name, index) => tail[index] === name)) {
      const tiebreakerText = tiebreaker.join(",");
      issues.push({
        field: "sort",
        code: "KAVO_QUERY_CONFLICTING_PARAMS",
        detail:
          `Cursor pagination needs a total order, so the effective sort must end in the unique ` +
          `${tiebreaker.length === 1 ? "field" : "fields, in this order,"} '${tiebreakerText}' — ` +
          `e.g. 'sort=-createdAt,${tiebreakerText}'. ` +
          (sort.length === 0
            ? `This request has no sort and ${config.entityName} declares no 'sort.default'.`
            : `This request sorts by '${sort.map((entry) => entry.field as string).join(", ")}'.`),
      });
    }
    // A cursor decoded against a sort that was itself rejected would report
    // a second, misleading issue ("3 values but the sort has 2"), so the
    // first page's worth of problems is reported alone.
    if (issues.length > before || pagination.cursor === null) {
      return pagination;
    }
    const values = decodeCursor(pagination.cursor, sort, this.fields, issues);
    if (values === null) {
      return pagination;
    }
    return { ...pagination, keyset: keysetExpression(sort, values) };
  }

  /**
   * Force the effective sort to `[since.field, idField]` ascending and
   * decode `since` — `"<value>|<id>"` — into the *same*
   * {@link keysetExpression} row-wise comparison cursor pagination uses
   * (ADR-0022).
   *
   * Unlike {@link resolveKeyset}, the sort here is never client-chosen: it
   * is entirely config-known (`pagination.since.field` plus `idField`), so
   * a client-supplied `sort` is **rejected**, not merely constrained — the
   * same treatment a stray `cursor=`/`since=` under the wrong strategy
   * gets, and for the same reason: silently overriding it would leave a
   * client believing its `sort` took effect when it didn't. A configured
   * `defaults.sort`, by contrast, is silently overridden — being
   * overridden by a more specific setting is what a default is for.
   *
   * The token carries an id precisely because a single-column
   * `since.field >= value` bound cannot make forward progress once a tied
   * group (rows sharing one `since.field` value) exceeds `limit`: every
   * poll would refetch the same leading slice of the tie forever. Composing
   * `keysetExpression` with `[since.field, idField]` values instead makes
   * `since` pagination exactly-once within a poll session, the same
   * guarantee cursor pagination has — `since`'s only remaining difference
   * from cursor is that the token is plain text, not opaque, and that
   * `nextSince` advances on every poll rather than only on a full page (see
   * `KavoEngine.sinceListMeta`).
   *
   * Field existence, kind (`date`/`string`), and allowlist membership are
   * already bootstrap-checked for the built-in `"since"` strategy
   * (`resolveEntityConfig`, since the sort it forces is entirely
   * config-known and not client-input-dependent the way cursor's is). The
   * same two allowlists (`filterable`, `selectable` — the reasons are
   * identical to cursor's, ADR-0021 §2) are re-checked here too, so a
   * third-party strategy emitting a `SincePagination` under another
   * registered name — which bypasses the bootstrap check entirely, since
   * that check is name-gated on `"since"` — cannot compose a keyset
   * predicate over, or leak via `meta.nextSince`, a column the allowlists
   * exclude.
   */
  private resolveSince(
    pagination: SincePagination<Entity>,
    clientSort: readonly Sort<Entity>[],
    config: ResolvedEntityConfig<Entity>,
    issues: QueryIssueDto[],
  ): { sort: readonly Sort<Entity>[]; pagination: SincePagination<Entity> } {
    // A composite key (issue #263) forces the tiebreaker to its full
    // `compositeIdFields` tuple instead of a single `idField` — the token's
    // id half then reuses `encodeCompositeId`/`decodeCompositeId`, the same
    // wire format a route id already uses (`sinceValueOf`, `since.ts`).
    const tiebreaker = this.metadata.compositeIdFields ?? [this.metadata.idField];
    const tiebreakerText = tiebreaker.join(",");
    const sinceFieldName = config.settings.pagination.since.field;
    const forcedSort: readonly Sort<Entity>[] = [
      { field: sinceFieldName as FieldPath<Entity>, direction: "asc" },
      ...tiebreaker.map((name) => ({ field: name as FieldPath<Entity>, direction: "asc" as const })),
    ];

    if (clientSort.length > 0) {
      issues.push({
        field: "sort",
        code: "KAVO_QUERY_CONFLICTING_PARAMS",
        detail:
          `Cannot page by 'since': the effective sort is forced to '${sinceFieldName},${tiebreakerText}' ` +
          `ascending, so requests may not supply their own 'sort'.`,
      });
    }

    const sinceField = this.fields.get(sinceFieldName);
    const tiebreakerMeta = tiebreaker.map((name) => this.fields.get(name));
    if (
      sinceField === undefined ||
      (sinceField.kind !== "date" && sinceField.kind !== "string") ||
      tiebreakerMeta.some((field) => field === undefined)
    ) {
      issues.push({
        field: "pagination.since.field",
        code: "KAVO_QUERY_CONFLICTING_PARAMS",
        detail: `'${sinceFieldName}' is not a 'date'- or 'string'-kind column of ${config.entityName}.`,
      });
      return { sort: forcedSort, pagination };
    }
    const before = issues.length;
    for (const name of [sinceFieldName, ...tiebreaker]) {
      if (requireAllowlisted(name, config, "filtering", issues)) {
        requireAllowlisted(name, config, "selection", issues);
      }
    }
    if (issues.length > before) {
      return { sort: forcedSort, pagination };
    }
    if (pagination.since === null) {
      return { sort: forcedSort, pagination };
    }

    const separator = pagination.since.lastIndexOf("|");
    if (separator < 0) {
      issues.push(invalidSince(`it is not a valid 'since' token — expected '<value>|<id>'`));
      return { sort: forcedSort, pagination };
    }
    const valueText = pagination.since.slice(0, separator);
    const idText = pagination.since.slice(separator + 1);

    const value = coerceScalar(valueText, "since", sinceField);
    if (isIssue(value)) {
      issues.push(value);
      return { sort: forcedSort, pagination };
    }
    if (value === null) {
      issues.push(
        invalidSince(
          `its value for '${sinceField.name}' is null, and since pagination cannot resume from a null sort key — ` +
            `sort by a column that is never null`,
        ),
      );
      return { sort: forcedSort, pagination };
    }

    const idFieldsMeta = tiebreakerMeta as FieldMetadata[];
    let idParts: readonly string[];
    if (idFieldsMeta.length === 1) {
      idParts = [idText];
    } else {
      const decoded = decodeCompositeId(idText, idFieldsMeta.length);
      if (decoded === null) {
        issues.push(
          invalidSince(`its id half does not decode into ${idFieldsMeta.length} key columns (${tiebreakerText})`),
        );
        return { sort: forcedSort, pagination };
      }
      idParts = decoded;
    }

    const ids: FilterScalar[] = [];
    for (const [index, meta] of idFieldsMeta.entries()) {
      const idValue = coerceScalar(idParts[index]!, "since", meta);
      if (isIssue(idValue)) {
        issues.push(idValue);
        return { sort: forcedSort, pagination };
      }
      if (idValue === null) {
        issues.push(invalidSince(`its id half is null, which cannot happen for a real row's primary key`));
        return { sort: forcedSort, pagination };
      }
      ids.push(idValue);
    }

    return { sort: forcedSort, pagination: { ...pagination, keyset: keysetExpression(forcedSort, [value, ...ids]) } };
  }

  /**
   * Hand the parsed paths and per-relation fieldsets to the resolver,
   * which owns every relation rule. Without a resolver there is
   * no relation graph to validate against, so an `include` is rejected
   * rather than quietly dropped.
   */
  private resolveIncludes(
    paths: readonly string[],
    fields: FieldSelection<Entity>,
    config: ResolvedEntityConfig<Entity>,
    issues: QueryIssueDto[],
  ): IncludeTree {
    const relationFields = fields.relations;
    if (paths.length === 0 && Object.keys(relationFields).length === 0 && !hasDefaultIncludes(config)) {
      return {};
    }
    if (this.includeResolver === null) {
      issues.push(unsupportedIssue("include"));
      return {};
    }
    try {
      return this.includeResolver.resolve({ paths, fields: relationFields }, config);
    } catch (error) {
      collectIssues(error, issues);
      return {};
    }
  }

  /**
   * Which shape this entity's configured strategy produces — probed
   * *structurally*, by asking the strategy what it produces for empty
   * params, rather than by comparing `pagination.strategy` to the strings
   * `"cursor"`/`"since"`. A third-party strategy registered as `"keyset"`
   * that returns a `CursorPagination` is narrowed correctly by
   * `isCursorPagination` on the wire path; comparing the name here would
   * silently downgrade the programmatic path to offset paging and reject
   * its `cursor` input as unsupported (same reasoning for `since`,
   * ADR-0022).
   *
   * A strategy that cannot normalize an empty request at all pages neither
   * way for this purpose — its own issues surface on the wire path, where
   * the params it needs actually exist.
   */
  private paginationShape(config: ResolvedEntityConfig<Entity>): "offset" | "cursor" | "since" {
    const { defaultLimit, maxLimit } = config.settings.pagination;
    try {
      const probe = this.strategyFor(config).normalize({}, { defaultLimit, maxLimit });
      if (isCursorPagination(probe)) {
        return "cursor";
      }
      if (isSincePagination(probe)) {
        return "since";
      }
      return "offset";
    } catch (error) {
      if (error instanceof QueryValidationException) {
        return "offset";
      }
      throw error;
    }
  }

  private strategyFor(config: ResolvedEntityConfig<Entity>): PaginationStrategy {
    const name = config.settings.pagination.strategy;
    const strategy = this.strategies.get(name);
    if (strategy === undefined) {
      throw new ConfigurationException(
        config.entityName,
        "pagination.strategy",
        `unknown strategy '${name}' (available: ${[...this.strategies.keys()].join(", ")})`,
      );
    }
    return strategy;
  }
}

/** Whether a raw `cursor`/`since` wire param was actually supplied (empty means "first page"). */
function hasValue(raw: unknown): boolean {
  return raw !== undefined && raw !== null && raw !== "";
}

/** One wording for "this entity does not page by keyset", on both entry points (ADR-0021, ADR-0022). */
function keysetParamUnsupportedIssue<Entity>(
  config: ResolvedEntityConfig<Entity>,
  param: "cursor" | "since",
): QueryIssueDto {
  return {
    field: param,
    code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    detail:
      `Query parameter '${param}' is not supported: ${config.entityName} paginates with ` +
      `strategy '${config.settings.pagination.strategy}'. Set 'pagination.strategy' to '${param}' to page by ${
        param === "cursor" ? "keyset" : "seeking since a value"
      }.`,
  };
}

/**
 * The programmatic-path counterpart of `NonePaginationStrategy`'s own
 * rejection (`pagination-strategies.ts`) — same field, same code, same
 * meaning, but genuinely **not** the identical string: `PaginationStrategy.
 * normalize(rawParams, limits)` carries no entity name for a strategy to
 * phrase its own message with (widening that signature to add one would be
 * a breaking change to every third-party strategy for one sentence's sake),
 * so the wire path's wording stays entity-agnostic ("this entity") while
 * this one, which already has `config` in scope, names the entity.
 */
function noneParamUnsupportedIssue<Entity>(
  config: ResolvedEntityConfig<Entity>,
  param: "limit" | "offset",
): QueryIssueDto {
  return {
    field: param,
    code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    detail:
      `Query parameter '${param}' is not supported: ${config.entityName} does not paginate ` +
      `('pagination.strategy' is 'none'), so every request serves the whole match set.`,
  };
}

/** Why one effective-sort entry disqualifies the whole request from keyset paging. */
function cursorSortIssue(field: string, reason: string): QueryIssueDto {
  return {
    field: "sort",
    code: "KAVO_QUERY_CONFLICTING_PARAMS",
    detail: `Cursor pagination cannot order by '${field}': it ${reason}.`,
  };
}

/** One wording for a rejected `since` token, mirroring `invalidCursor` in `cursor.ts`. */
function invalidSince(reason: string): QueryIssueDto {
  return {
    field: "since",
    code: "KAVO_QUERY_INVALID_VALUE",
    detail: `The 'since' parameter was rejected: ${reason}. Pass back 'meta.nextSince' from the previous poll verbatim.`,
  };
}

function unsupportedIssue(param: string): QueryIssueDto {
  return {
    field: param,
    code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    detail: `Query parameter '${param}' is not supported: this entity has no relation graph to resolve it against.`,
  };
}

/** Whether anything would be included even with an empty request. */
function hasDefaultIncludes<Entity>(config: ResolvedEntityConfig<Entity>): boolean {
  return config.relations.all().some((relation) => relation.defaultInclude === true && relation.includable);
}

/** `include=posts.comments,profile`, or the repeated-key array form. */
function parseIncludePaths(raw: unknown, issues: QueryIssueDto[]): readonly string[] {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }
  const tokens = Array.isArray(raw) ? raw : [raw];
  const paths: string[] = [];
  for (const token of tokens) {
    if (typeof token !== "string") {
      issues.push({
        field: "include",
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: "'include' must be a comma-separated list of relation paths.",
      });
      continue;
    }
    for (const path of token.split(",")) {
      if (path !== "") {
        paths.push(path);
      }
    }
  }
  return paths;
}

/**
 * `withDeleted` / `onlyDeleted`: opt out of the default exclusion of
 * soft-deleted rows, or narrow a read to only them. Asking for either on an
 * entity that resolves to a hard delete strategy is rejected rather than
 * silently ignored — a client that thinks it is seeing deleted rows should
 * be told it is not. Setting both together is a separate conflict check
 * (see {@link conflictingSoftDeleteFlagsIssue}), since each is individually
 * valid on a soft-deletable entity.
 */
function parseSoftDeleteFlag<Entity>(
  field: "withDeleted" | "onlyDeleted",
  raw: unknown,
  config: ResolvedEntityConfig<Entity>,
  issues: QueryIssueDto[],
): boolean {
  if (raw === undefined || raw === null || raw === "" || raw === false || raw === "false" || raw === "0") {
    return false;
  }
  if (raw !== true && raw !== "true" && raw !== "1") {
    issues.push({
      field,
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: `Value '${String(raw)}' for field '${field}' is not a valid boolean.`,
    });
    return false;
  }
  if (config.softDelete.strategy !== "soft") {
    issues.push({
      field,
      code: "KAVO_QUERY_UNSUPPORTED_PARAM",
      detail:
        `Query parameter '${field}' is not supported: ` +
        `${config.entityName} is not soft-deletable, so no rows are excluded.`,
    });
    return false;
  }
  return true;
}

/** `withDeleted=true` and `onlyDeleted=true` together is a contradiction: "everything" vs. "only the deleted". */
function conflictingSoftDeleteFlagsIssue(): QueryIssueDto {
  return {
    field: "onlyDeleted",
    code: "KAVO_QUERY_CONFLICTING_PARAMS",
    detail:
      "Query parameters 'withDeleted' and 'onlyDeleted' cannot be used together: " +
      "'withDeleted' includes both live and deleted rows, while 'onlyDeleted' restricts to deleted rows only.",
  };
}

/** `-field` → `{ field, direction: "desc" }`; `field` → `{ field, direction: "asc" }`. */
function parseSortToken<Entity>(token: string): Sort<Entity> {
  const descending = token.startsWith("-");
  const field = descending ? token.slice(1) : token;
  return { field: field as FieldPath<Entity>, direction: descending ? "desc" : "asc" };
}

function parseSort<Entity>(
  raw: unknown,
  config: ResolvedEntityConfig<Entity>,
  issues: QueryIssueDto[],
): readonly Sort<Entity>[] {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }
  if (typeof raw !== "string") {
    issues.push({
      field: "sort",
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: "'sort' must be a comma-separated field list.",
    });
    return [];
  }
  const result: Sort<Entity>[] = [];
  for (const token of raw.split(",")) {
    if (token === "") {
      continue;
    }
    const entry = parseSortToken<Entity>(token);
    if (requireAllowlisted(entry.field as string, config, "sorting", issues)) {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Collapse the three caller-facing `select` spellings into the canonical
 * `{ root, relations }` pair — the programmatic mirror of what
 * {@link parseSelect} does for wire params.
 *
 * Discrimination is structural and in this order: an array is root-only
 * sugar; an object naming `root` or `relations` is the structured form;
 * anything else is relation-keyed. That is what makes `root` and
 * `relations` reserved keys (documented on `FieldSelectionInput`).
 *
 * Shape validation *is* part of this function — unlike the rest of the
 * fieldset (which the caller allowlist-checks and the include resolver
 * validates), a malformed `select` value has no later gate to catch it, so
 * this is the one place it can be. A non-object value or a structured
 * literal mixing in a relation-keyed key both fail the same way `parseSelect`
 * fails the equivalent wire input: an issue, not a thrown error — nothing
 * here may throw, or it surfaces as a 500 instead of a 400.
 */
function collapseFieldSelection<Entity>(
  input: FieldSelectionInput<Entity> | undefined,
  issues: QueryIssueDto[],
): {
  readonly root: readonly FieldPath<Entity, 1>[] | null;
  readonly relations: Readonly<Record<string, readonly string[]>>;
} {
  if (input === undefined) {
    return { root: null, relations: {} };
  }
  if (Array.isArray(input)) {
    return { root: input as readonly FieldPath<Entity, 1>[], relations: {} };
  }
  if (input === null || typeof input !== "object") {
    issues.push({
      field: "select",
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: "'select' must be an array, or an object of relation fieldsets.",
    });
    return { root: null, relations: {} };
  }
  const structured = input as Partial<FieldSelection<Entity>>;
  if ("root" in structured || "relations" in structured) {
    const unknownKeys = Object.keys(structured).filter((key) => key !== "root" && key !== "relations");
    for (const key of unknownKeys) {
      issues.push({
        field: `select.${key}`,
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: `'select.${key}' cannot be mixed with 'root'/'relations' — use 'relations.${key}' instead.`,
      });
    }
    return { root: structured.root ?? null, relations: structured.relations ?? {} };
  }
  return { root: null, relations: input as Readonly<Record<string, readonly string[]>> };
}

function parseSelect<Entity>(
  rawParams: Readonly<Record<string, unknown>>,
  config: ResolvedEntityConfig<Entity>,
  issues: QueryIssueDto[],
): FieldSelection<Entity> {
  // `select[posts.comments]=id,body` — the key is the relation path. The
  // include resolver validates it against the *target* entity's allowlist,
  // so nothing beyond shape is checked here.
  //
  // Null-prototype, for the same reason the filter parser builds its tree
  // that way: the key is attacker-controlled, and `relations["__proto__"] =
  // [...]` on an ordinary object invokes the prototype setter — the fieldset
  // silently vanishes instead of reaching the resolver and being rejected.
  const relations: Record<string, readonly string[]> = Object.create(null);
  for (const key of Object.keys(rawParams)) {
    const segments = parseBracketKey(key, "select");
    if (segments === null || segments.length !== 1 || segments[0] === "") {
      continue;
    }
    const value = rawParams[key];
    if (typeof value !== "string") {
      issues.push({
        field: key,
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: `'${key}' must be a comma-separated field list.`,
      });
      continue;
    }
    relations[segments[0]!] = value.split(",").filter((field) => field !== "");
  }

  const raw = rawParams["select"];
  if (raw === undefined || raw === null || raw === "") {
    return { root: null, relations };
  }
  if (typeof raw !== "string") {
    issues.push({
      field: "select",
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: "'select' must be a comma-separated field list.",
    });
    return { root: null, relations };
  }
  const root: FieldPath<Entity, 1>[] = [];
  for (const field of raw.split(",")) {
    if (field === "") {
      continue;
    }
    if (requireAllowlisted(field, config, "selection", issues)) {
      root.push(field as FieldPath<Entity, 1>);
    }
  }
  return { root, relations };
}

/**
 * `search[query]`/`search[mode]`/`search[fields]` (doc 05 §4): validated and
 * synthesized here, in the normalizer, rather than the filter parser —
 * `searchable` is an allowlist and `search` (`false` or `{ mode }`) is a per-operation
 * settings, both already in the normalizer's scope, and synthesis needs the
 * already-parsed `filter` to `AND` the fragment into.
 *
 * Wire-only: there is no programmatic `QueryContext.search` — a programmatic
 * caller composes the equivalent `ILIKE` conditions directly, the same way
 * it composes any other filter.
 */
function parseSearch<Entity>(
  rawParams: Readonly<Record<string, unknown>>,
  filter: Filter<Entity>,
  config: ResolvedEntityConfig<Entity>,
  issues: QueryIssueDto[],
): Filter<Entity> {
  const explicitQuery = rawParams["search[query]"];
  const modeRaw = rawParams["search[mode]"];
  const fieldsRaw = rawParams["search[fields]"];
  // `search.default` (issue #386): the free-text term a request gets when
  // it sends no `search[query]` of its own.
  const query = hasValue(explicitQuery) ? explicitQuery : (config.search !== false ? config.search.default : null);

  if (!hasValue(query)) {
    if (hasValue(modeRaw) || hasValue(fieldsRaw)) {
      issues.push({
        field: "search",
        code: "KAVO_QUERY_CONFLICTING_PARAMS",
        detail: `'search[mode]' and 'search[fields]' modify a search — they require 'search[query]', which was not given.`,
      });
    }
    return filter;
  }
  if (typeof query !== "string") {
    issues.push({
      field: "search[query]",
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: `'search[query]' must be a string.`,
    });
    return filter;
  }

  const search = config.search;
  if (search === false) {
    issues.push({
      field: "search[query]",
      code: "KAVO_QUERY_UNSUPPORTED_PARAM",
      detail:
        `Query parameter 'search[query]' is not supported: search is not enabled for ${config.entityName}. ` +
        `Set 'search' to an object to turn it on.`,
    });
    return filter;
  }
  const searchable = search.fields as readonly string[];
  if (searchable.length === 0) {
    issues.push({
      field: "search[query]",
      code: "KAVO_QUERY_UNSUPPORTED_PARAM",
      detail:
        `Query parameter 'search[query]' is not supported: ${config.entityName} has no searchable fields ` +
        `('search.fields' resolves to an empty set).`,
    });
    return filter;
  }

  const before = issues.length;
  let mode = search.mode;
  if (hasValue(modeRaw)) {
    if (modeRaw !== "substring" && modeRaw !== "words") {
      issues.push({
        field: "search[mode]",
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: `'search[mode]' must be 'substring' or 'words', got '${String(modeRaw)}'.`,
      });
    } else {
      mode = modeRaw;
    }
  }

  let fields = searchable;
  if (hasValue(fieldsRaw)) {
    if (typeof fieldsRaw !== "string") {
      issues.push({
        field: "search[fields]",
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: `'search[fields]' must be a comma-separated field list.`,
      });
    } else {
      const requested = fieldsRaw.split(",").filter((field) => field !== "");
      let valid = true;
      for (const field of requested) {
        if (searchable.includes(field)) {
          continue;
        }
        valid = false;
        pushAllowlistIssue(field, "searching", config.entityName, searchable, issues);
      }
      if (valid) {
        fields = requested;
      }
    }
  }

  if (issues.length > before) {
    return filter;
  }

  const words = mode === "words" ? query.split(/\s+/).filter((word) => word !== "") : [query];
  const terms = words.length > 0 ? words : [query];
  // Synthesized width is `terms.length * fields.length` — one ILIKE
  // condition per searched field, per term — unlike `filter[...]`'s
  // `IN`/`NOT_IN`/`BETWEEN`, which has no analogous width multiplier
  // (`limits.filterDepth` caps nesting depth, not a group's child count).
  // Capping `terms.length` alone leaves the product unbounded whenever
  // `searchable` (or a wide `search[fields]`) carries many entries — its
  // own default is *every* own string column, so this is not a contrived
  // case. `limits.inValues` is already "how many operands may one param
  // carry"; reused on the product, rather than adding a second limit key,
  // so neither factor alone can still synthesize an unbounded predicate.
  const max = config.filter.limits.maxInValues;
  const width = terms.length * fields.length;
  if (width > max) {
    issues.push({
      field: "search[query]",
      code: "KAVO_QUERY_LIMIT_EXCEEDED",
      detail:
        `'search[mode]=words' would synthesize ${terms.length} words × ${fields.length} searched fields = ` +
        `${width} conditions; the maximum is ${max}.`,
    });
    return filter;
  }
  const groups = terms.map((term) => searchGroup<Entity>(fields, term));
  const synthesized: FilterExpression<Entity> =
    groups.length === 1
      ? (groups[0] as FilterExpression<Entity>)
      : { kind: "group", operator: "AND", children: groups };

  const root: FilterExpression<Entity> =
    filter.root === null ? synthesized : { kind: "group", operator: "AND", children: [filter.root, synthesized] };
  return { root };
}

/** One `OR` group of `field ILIKE '%term%'`, one condition per searched field. */
function searchGroup<Entity>(fields: readonly string[], term: string): FilterExpression<Entity> {
  const pattern = `%${escapeLikeLiteral(term)}%`;
  const conditions: FilterCondition<Entity>[] = fields.map((field) => ({
    kind: "condition",
    field: field as FieldPath<Entity>,
    operator: "ILIKE",
    value: pattern,
  }));
  return conditions.length === 1
    ? (conditions[0] as FilterExpression<Entity>)
    : { kind: "group", operator: "OR", children: conditions };
}

/**
 * Escapes a literal `%`/`_` (and the backslash escape character itself)
 * with the backslash convention the filter grammar's `like`/`ilike`
 * operators already use (doc 05 §3) — the same escape every
 * `FilterTranslator` already unescapes, so a search term never has its
 * characters read back as SQL wildcards.
 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function validateExpression<Entity>(
  expression: FilterExpression<Entity>,
  config: ResolvedEntityConfig<Entity>,
  issues: QueryIssueDto[],
  depth = 1,
): void {
  if (depth > config.filter.limits.maxDepth) {
    issues.push({
      field: "filter",
      code: "KAVO_QUERY_LIMIT_EXCEEDED",
      detail: `Filter depth exceeds the configured maximum of ${config.filter.limits.maxDepth}.`,
    });
    return;
  }
  if (expression.kind === "condition") {
    requireAllowlisted(expression.field as string, config, "filtering", issues);
    const value = expression.value;
    if (Array.isArray(value) && value.length > config.filter.limits.maxInValues) {
      issues.push({
        field: expression.field as string,
        code: "KAVO_QUERY_LIMIT_EXCEEDED",
        detail: `'${expression.operator}' carries ${value.length} values; the maximum is ${config.filter.limits.maxInValues}.`,
      });
    }
    if (
      (expression.operator === "LIKE" || expression.operator === "ILIKE") &&
      typeof value === "string" &&
      value.length > config.filter.limits.maxLikePatternLength
    ) {
      issues.push({
        field: expression.field as string,
        code: "KAVO_QUERY_LIMIT_EXCEEDED",
        detail: `'${expression.operator}' pattern is ${value.length} characters; the maximum is ${config.filter.limits.maxLikePatternLength}.`,
      });
    }
    return;
  }
  for (const child of expression.children) {
    validateExpression(child, config, issues, depth + 1);
  }
}

/** Which field-group's `fields` each usage reads, so the caller names only the usage. */
function fieldsFor<Entity>(config: ResolvedEntityConfig<Entity>, usage: AllowlistUsage): readonly string[] {
  switch (usage) {
    case "filtering":
      return config.filter.fields as readonly string[];
    case "sorting":
      return config.sort.fields as readonly string[];
    case "selection":
      return config.select.fields as readonly string[];
    case "searching":
      // `requireAllowlisted` is never called with "searching" — `parseSearch`
      // calls `pushAllowlistIssue` directly, since `search[fields]` narrows a
      // different base set, only reachable once `config.search !== false`.
      // Present for type completeness against `AllowlistUsage`.
      return config.search === false ? [] : (config.search.fields as readonly string[]);
  }
}

/**
 * The single allowlist gate for the programmatic entry point and the wire
 * one alike. On rejection the issue names the near miss, the permitted set,
 * and the config key that would permit the field — the leading sentence is
 * unchanged, everything actionable is appended.
 */
function requireAllowlisted<Entity>(
  field: string,
  config: ResolvedEntityConfig<Entity>,
  usage: AllowlistUsage,
  issues: QueryIssueDto[],
): boolean {
  const allowed = fieldsFor(config, usage);
  if (allowed.includes(field)) {
    return true;
  }
  pushAllowlistIssue(field, usage, config.entityName, allowed, issues);
  return false;
}

function collectIssues(error: unknown, issues: QueryIssueDto[]): void {
  if (error instanceof QueryValidationException) {
    issues.push(...error.issues);
    return;
  }
  throw error;
}
