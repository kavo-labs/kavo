import type { EntityCatalog, EntityRuntimeInfo } from "../metadata/entity-catalog.js";
import type { IncludeNode, IncludeTree } from "./include-tree.js";
import type { IncludeRequest, IncludeResolver } from "./include-resolver.js";
import type { QueryIssueDto } from "../errors/problem-details.js";
import type { RelationDescriptor } from "./relation-descriptor.js";
import type { ResolvedEntityConfig } from "../config/resolved-entity-config.js";
import { QueryValidationException } from "../errors/exceptions.js";
import { allowlistHint, nameList, suggestName } from "../errors/message-hints.js";

/** A pending node, before validation turns it into an `IncludeNode`. */
interface DraftNode {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, DraftNode>;
}

/**
 * The include-resolution algorithm:
 *
 * 1. parse dot-paths into a tree — overlapping paths merge, so `posts` and
 *    `posts.comments` produce one `posts` node with a `comments` child;
 * 2. validate every edge against the relation registry of the entity that
 *    *owns* it (unknown or non-includable → 400, never a silent drop);
 * 3. enforce `maxIncludeDepth`, per-relation `maxDepth` overrides below a
 *    node, and `maxIncludedNodes` across the whole tree;
 * 4. attach sparse fieldsets, validated against the target's selectable
 *    allowlist;
 * 5. resolve `auto` strategies and the target's delete strategy, so the
 *    adapter receives decisions rather than questions.
 *
 * Depth is the only cycle guard: `manager.manager.manager` is legal until
 * it runs out of depth budget. Visited-type tracking would forbid a
 * legitimate self-relation, and depth is the contract clients can reason
 * about.
 *
 * Every issue across the whole tree is collected before throwing, matching
 * the rest of the query pipeline: one round trip, all problems.
 */
export class DefaultIncludeResolver<Entity extends object = object> implements IncludeResolver<Entity> {
  constructor(private readonly catalog: EntityCatalog) {}

  resolve(request: IncludeRequest, config: ResolvedEntityConfig<Entity>): IncludeTree {
    const issues: QueryIssueDto[] = [];
    const drafts = new Map<string, DraftNode>();
    for (const path of request.paths) {
      addPath(drafts, path, issues);
    }

    const budget = { remaining: config.settings.relations.maxIncludedNodes };
    const tree = this.build(
      drafts,
      config as unknown as ResolvedEntityConfig<object>,
      request,
      config.settings.relations.maxIncludeDepth,
      budget,
      issues,
    );

    if (issues.length > 0) {
      throw new QueryValidationException(issues, { context: { entityName: config.entityName } });
    }
    return tree;
  }

  /** One level of the tree, against the config of the entity owning it. */
  private build(
    drafts: Map<string, DraftNode>,
    owner: ResolvedEntityConfig<object>,
    request: IncludeRequest,
    depthBudget: number,
    nodeBudget: { remaining: number },
    issues: QueryIssueDto[],
    parentPath = "",
  ): IncludeTree {
    // Relations marked `defaultInclude` join the tree even when the client
    // asked for nothing — but only where they are reachable, so they obey
    // the same depth budget as anything else.
    for (const relation of owner.relations.all()) {
      if (relation.defaultInclude !== true || !relation.includable) {
        continue;
      }
      if (drafts.has(relation.name)) {
        continue;
      }
      const path = parentPath === "" ? relation.name : `${parentPath}.${relation.name}`;
      drafts.set(relation.name, { name: relation.name, path, children: new Map() });
    }
    if (drafts.size === 0) {
      return {};
    }

    const tree: Record<string, IncludeNode> = {};
    for (const draft of drafts.values()) {
      const relation = owner.relations.get(draft.name);
      // A name that is not a relation at all and a relation the config never
      // opted in are the same rejection to the client, deliberately: the
      // registry keeps every metadata relation and flips `includable` only
      // for names on `allowlists.includable` (ADR-0028), so wording the two
      // differently would confirm the existence of the relations that
      // allowlist closed on purpose (the disclosure rule in
      // `errors/message-hints.ts`). What issue #7 was actually about — the
      // message never naming the config key that grants inclusion — is
      // fixed without that split, by stating the key as a conditional the
      // developer can act on and a prober learns nothing from.
      if (relation === undefined || !relation.includable) {
        const includable = includableNames(owner);
        issues.push({
          field: draft.path,
          code: "KAVO_QUERY_INVALID_FIELD",
          detail:
            `Relation '${draft.name}' is not includable on ${owner.entityName}${inPath(draft)}.` +
            `${suggestion(draft.name, includable)}` +
            ` Includable relations on ${owner.entityName}: ${nameList(includable)}.` +
            ` If ${owner.entityName} has a '${draft.name}' relation, opt in by naming it in` +
            ` allowlists.includable on the ${owner.entityName} config.`,
        });
        continue;
      }
      if (depthBudget < 1) {
        issues.push({
          field: draft.path,
          code: "KAVO_QUERY_LIMIT_EXCEEDED",
          detail:
            `Include path '${draft.path}' is deeper than the configured maximum ` +
            `of ${owner.settings.relations.maxIncludeDepth}.`,
        });
        continue;
      }
      if (nodeBudget.remaining < 1) {
        issues.push({
          field: draft.path,
          code: "KAVO_QUERY_LIMIT_EXCEEDED",
          detail: `Include tree exceeds the configured maximum of ${owner.settings.relations.maxIncludedNodes} nodes.`,
        });
        continue;
      }

      const target = this.targetOf(relation, draft, issues);
      if (target === undefined) {
        continue;
      }
      nodeBudget.remaining -= 1;

      const resolvedStrategy =
        relation.strategy === "auto" ? (relation.cardinality === "many" ? "batch" : "join") : relation.strategy;

      if (resolvedStrategy === "key") {
        tree[draft.name] = {
          relation,
          path: draft.path,
          fields: this.keyFieldset(draft, request, target, issues),
          strategy: "key",
          keyField: target.metadata.idField,
          softDelete: target.config.softDelete,
          // A `key` node materializes only the FK — there is nothing below
          // it to load, so a nested path through it is a client error, not
          // a silently-truncated tree.
          children: this.rejectKeyChildren(draft, issues),
        };
        continue;
      }

      tree[draft.name] = {
        relation,
        path: draft.path,
        fields: this.fieldsFor(draft, request, target.config, issues),
        strategy: resolvedStrategy,
        softDelete: target.config.softDelete,
        children: this.build(
          draft.children,
          target.config,
          request,
          // A relation's own `maxDepth` replaces the inherited budget for
          // everything below it — tightening or loosening one subtree.
          (relation.maxDepth ?? depthBudget) - 1,
          nodeBudget,
          issues,
          draft.path,
        ),
      };
    }
    return tree;
  }

  /**
   * The fieldset for a `strategy: "key"` node: always exactly the target's
   * primary key. An explicit `select[<path>]=` may name only that key —
   * anything else is a 400, since a `key` edge never loads another column.
   * A composite-key target has no single local FK column to read, so it is
   * rejected outright (a follow-up may lift this).
   *
   * The target's own `selectable` allowlist is deliberately *not* consulted
   * (unlike the `join`/`batch` path): the value comes from the parent row's
   * foreign-key column, not from a row of the target, so the target's
   * selection policy has no say — the same reason its soft-delete state has
   * none.
   */
  private keyFieldset(
    draft: DraftNode,
    request: IncludeRequest,
    target: EntityRuntimeInfo,
    issues: QueryIssueDto[],
  ): readonly string[] {
    const pk = target.metadata.idField;
    if (target.metadata.compositeIdFields !== undefined) {
      issues.push({
        field: draft.path,
        code: "KAVO_QUERY_UNSUPPORTED_PARAM",
        detail:
          `Relation '${draft.path}' uses strategy 'key', which reads a single local foreign-key column, ` +
          `but its target '${target.config.entityName}' has a composite primary key.`,
      });
      return [pk];
    }
    const requested = request.fields[draft.path];
    if (requested !== undefined) {
      for (const field of Array.isArray(requested) ? requested : []) {
        if (field !== pk) {
          issues.push({
            field: `${draft.path}.${field}`,
            code: "KAVO_QUERY_INVALID_FIELD",
            detail:
              `Field '${field}' cannot be selected on '${draft.path}': it loads through strategy 'key', ` +
              `which exposes only the primary key '${pk}'.`,
          });
        }
      }
    }
    return [pk];
  }

  /**
   * A `key` node cannot carry children — the FK is all it loads. Any nested
   * draft path is reported and dropped, so `IncludeNode.children` stays an
   * invariant-empty object for `key` nodes and adapters need no guard.
   */
  private rejectKeyChildren(draft: DraftNode, issues: QueryIssueDto[]): IncludeTree {
    for (const child of draft.children.values()) {
      issues.push({
        field: child.path,
        code: "KAVO_QUERY_INVALID_FIELD",
        detail:
          `Include path '${child.path}' is not resolvable: '${draft.path}' loads through strategy 'key', ` +
          `which materializes only the foreign-key id and has no nested relations to include.`,
      });
    }
    return {};
  }

  private targetOf(
    relation: RelationDescriptor,
    draft: DraftNode,
    issues: QueryIssueDto[],
  ): EntityRuntimeInfo | undefined {
    const target = this.catalog.get(relation.target());
    if (target === undefined) {
      issues.push({
        field: draft.path,
        code: "KAVO_QUERY_UNSUPPORTED_PARAM",
        detail:
          `Query parameter 'include' cannot resolve '${draft.path}': the target entity is ` +
          `unknown to this Kavo instance.`,
      });
    }
    return target;
  }

  /**
   * A node's sparse fieldset, gated by the *target* entity's `selectable`
   * allowlist — never the including entity's (ADR-0026 decision 4; the
   * ADR-0044 parent-side ceiling was removed in ADR-0045). `null` when the
   * request sends no `select[<path>]=` for this node: the target's own
   * default projection then applies at serialization. With a request, a
   * field outside the target's `selectable` is a 400. Stitching keys are
   * not added here: they are fetched regardless and stripped at
   * serialization.
   */
  private fieldsFor(
    draft: DraftNode,
    request: IncludeRequest,
    target: ResolvedEntityConfig<object>,
    issues: QueryIssueDto[],
  ): readonly string[] | null {
    const requested = request.fields[draft.path];
    if (requested === undefined) {
      return null;
    }
    // `IncludeRequest.fields` types this as `readonly string[]`, but the
    // programmatic `QueryContext.select` entry point can hand a caller's
    // malformed value straight through — the wire path (`parseSelect`)
    // guarantees an array of strings and never reaches this branch. A
    // shape this far from what was declared must become an issue, not an
    // uncaught `TypeError` from the loop below: that would surface as a
    // 500, the same class of bug already closed for the top-level `select`
    // value in `QueryNormalizer.collapseFieldSelection`.
    if (!Array.isArray(requested)) {
      issues.push({
        field: draft.path,
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: `'select.${draft.path}' must be an array of field names.`,
      });
      return null;
    }
    const allowed = target.allowlists.selectable as readonly string[];
    const fields: string[] = [];
    for (const field of requested) {
      if (!allowed.includes(field)) {
        issues.push({
          field: `${draft.path}.${field}`,
          code: "KAVO_QUERY_INVALID_FIELD",
          detail:
            `Field '${field}' cannot be used for selection on '${draft.path}'.` +
            // The allowlist that rejected it is the *target* entity's, so the
            // config key the developer has to edit is the target's too.
            allowlistHint(field, "selection", target.entityName, allowed),
        });
        continue;
      }
      fields.push(field);
    }
    return fields;
  }
}

/**
 * The relations a client is permitted to include on this entity — the only
 * names a rejection may enumerate. `all()` also holds relations the config
 * never opted in, and naming those would turn an error message into a
 * schema dump (the disclosure rule in `errors/message-hints.ts`).
 */
function includableNames(owner: ResolvedEntityConfig<object>): readonly string[] {
  return owner.relations
    .all()
    .filter((relation) => relation.includable)
    .map((relation) => relation.name);
}

/**
 * ` (in include path 'posts.comments')` — omitted at the top level, where
 * the path and the relation name are the same string and repeating it adds
 * nothing.
 */
function inPath(draft: DraftNode): string {
  return draft.path === draft.name ? "" : ` (in include path '${draft.path}')`;
}

function suggestion(name: string, candidates: readonly string[]): string {
  const match = suggestName(name, candidates);
  return match === undefined ? "" : ` Did you mean '${match}'?`;
}

/** Merge one dot-path into the draft tree, sharing prefixes. */
function addPath(drafts: Map<string, DraftNode>, path: string, issues: QueryIssueDto[]): void {
  const segments = path.split(".");
  if (segments.some((segment) => segment === "")) {
    issues.push({
      field: "include",
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: `Include path '${path}' is malformed: segments must be non-empty, dot-separated relation names.`,
    });
    return;
  }
  let level = drafts;
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix === "" ? segment : `${prefix}.${segment}`;
    let node = level.get(segment);
    if (node === undefined) {
      node = { name: segment, path: prefix, children: new Map() };
      level.set(segment, node);
    }
    level = node.children;
  }
}
