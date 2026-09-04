import type { KavoSettings } from "./settings.js";
import { ConfigurationException } from "../errors/exceptions.js";
import { STANDARD_OPERATIONS } from "../operations/default-operation-registry.js";

/**
 * Mirrors `RealtimeEventId` (realtime/realtime-event.ts) — kept as a plain
 * `ReadonlySet<string>` rather than importing the type, since this checks
 * arbitrary keys off `Object.entries` and has no literal-union to narrow to.
 */
const REALTIME_EVENT_IDS: ReadonlySet<string> = new Set(["created", "updated", "patched", "deleted", "restored"]);

/**
 * Bootstrap validation. Fails fast with an error naming the
 * entity, the key path, and the offending value — config errors surface at
 * startup, never as mysterious runtime behavior.
 */
export function validateSettings(entityName: string, settings: KavoSettings): void {
  const positiveInt = (path: string, value: unknown): void => {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new ConfigurationException(entityName, path, `expected a positive integer, got ${JSON.stringify(value)}`);
    }
  };
  const bool = (path: string, value: unknown): void => {
    if (typeof value !== "boolean") {
      throw new ConfigurationException(entityName, path, `expected a boolean, got ${JSON.stringify(value)}`);
    }
  };

  positiveInt("pagination.defaultLimit", settings.pagination.defaultLimit);
  positiveInt("pagination.maxLimit", settings.pagination.maxLimit);
  bool("pagination.count", settings.pagination.count);
  if (typeof settings.pagination.strategy !== "string") {
    throw new ConfigurationException(
      entityName,
      "pagination.strategy",
      `expected a strategy name, got ${JSON.stringify(settings.pagination.strategy)}`,
    );
  }
  if (settings.pagination.defaultLimit > settings.pagination.maxLimit) {
    throw new ConfigurationException(
      entityName,
      "pagination.defaultLimit",
      `defaultLimit (${settings.pagination.defaultLimit}) exceeds maxLimit (${settings.pagination.maxLimit})`,
    );
  }
  if (typeof settings.pagination.since.field !== "string" || settings.pagination.since.field === "") {
    throw new ConfigurationException(
      entityName,
      "pagination.since.field",
      `expected a non-empty field name, got ${JSON.stringify(settings.pagination.since.field)}`,
    );
  }

  positiveInt("query.maxFilterDepth", settings.query.maxFilterDepth);
  positiveInt("query.maxInValues", settings.query.maxInValues);
  positiveInt("query.maxLikePatternLength", settings.query.maxLikePatternLength);

  const search = settings.query.search;
  if (search !== false) {
    if (search.mode !== "substring" && search.mode !== "words") {
      throw new ConfigurationException(
        entityName,
        "query.search.mode",
        `expected "substring" or "words", got ${JSON.stringify(search.mode)}`,
      );
    }
    if (search.driver !== "orm") {
      throw new ConfigurationException(
        entityName,
        "query.search.driver",
        `expected "orm" (the only driver this schema accepts today), got ${JSON.stringify(search.driver)}`,
      );
    }
  }

  bool("errors.exposeInternals", settings.errors.exposeInternals);

  positiveInt("relations.maxIncludeDepth", settings.relations.maxIncludeDepth);
  positiveInt("relations.maxIncludedNodes", settings.relations.maxIncludedNodes);
  for (const [name, edge] of Object.entries(settings.relations.edges)) {
    const path = `relations.edges.${name}`;
    if (typeof edge !== "object" || edge === null) {
      throw new ConfigurationException(entityName, path, `expected an object, got ${JSON.stringify(edge)}`);
    }
    if (edge.maxDepth !== undefined) {
      positiveInt(`${path}.maxDepth`, edge.maxDepth);
    }
    if (edge.strategy !== undefined && !["join", "batch", "key", "auto"].includes(edge.strategy)) {
      throw new ConfigurationException(
        entityName,
        `${path}.strategy`,
        `expected "join", "batch", "key", or "auto", got ${JSON.stringify(edge.strategy)}`,
      );
    }
    if (edge.write !== undefined && typeof edge.write !== "boolean") {
      if (typeof edge.write !== "object" || edge.write === null) {
        throw new ConfigurationException(
          entityName,
          `${path}.write`,
          `expected a boolean or { strategy: "replace" | "resource" | "jsonPatch" }, got ${JSON.stringify(edge.write)}`,
        );
      }
      const strategy = edge.write.strategy;
      if (strategy !== "replace" && strategy !== "resource" && strategy !== "jsonPatch") {
        throw new ConfigurationException(
          entityName,
          `${path}.write.strategy`,
          `expected "replace", "resource", or "jsonPatch", got ${JSON.stringify(strategy)}`,
        );
      }
    }
  }

  const stringArray = (path: string, value: unknown): void => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new ConfigurationException(
        entityName,
        path,
        `expected an array of non-empty strings, got ${JSON.stringify(value)}`,
      );
    }
  };
  stringArray("defaults.sort", settings.defaults.sort);
  if (settings.defaults.select !== undefined) {
    stringArray("defaults.select", settings.defaults.select);
  }
  stringArray("defaults.include", settings.defaults.include);
  // `defaults.sort`/`defaults.select` vs. `allowed.sortable`/`allowed.selectable`,
  // and `defaults.include` vs. `allowed.includable` (permission, ADR-0028),
  // are cross-checked in `resolve-entity-config.ts`'s `validateDefaults`, not
  // here — this function only sees `KavoSettings`, and `allowed` is
  // entity-typed config outside that schema.

  if (settings.cache !== false) {
    const cache = settings.cache;
    if (typeof cache !== "object" || cache === null) {
      throw new ConfigurationException(
        entityName,
        "cache",
        `expected { ttl: number, etag: boolean } or false, got ${JSON.stringify(cache)} — ` +
          `to turn result caching and ETags off together, set 'cache' to false`,
      );
    }
    if (!Number.isInteger(cache.ttl) || (cache.ttl as number) < 0) {
      throw new ConfigurationException(
        entityName,
        "cache.ttl",
        `expected a non-negative integer (0 disables the result cache), got ${JSON.stringify(cache.ttl)}`,
      );
    }
    bool("cache.etag", cache.etag);
  }

  if (settings.softDelete !== false) {
    if (
      typeof settings.softDelete !== "object" ||
      settings.softDelete === null ||
      typeof settings.softDelete.field !== "string" ||
      settings.softDelete.field.length === 0
    ) {
      throw new ConfigurationException(
        entityName,
        "softDelete",
        `expected false or { field: string, strategy: … }, got ${JSON.stringify(settings.softDelete)}`,
      );
    }
    const strategy = settings.softDelete.strategy;
    if (strategy !== "auto" && strategy !== "soft" && strategy !== "hard") {
      throw new ConfigurationException(
        entityName,
        "softDelete.strategy",
        `expected "auto", "soft", or "hard", got ${JSON.stringify(strategy)}`,
      );
    }
  }

  if (settings.realtime !== false) {
    const realtime = settings.realtime;
    if (typeof realtime !== "object" || realtime === null) {
      throw new ConfigurationException(
        entityName,
        "realtime",
        `expected false or { events: {...} }, got ${JSON.stringify(realtime)}`,
      );
    }
    if (realtime.events !== undefined) {
      if (typeof realtime.events !== "object" || realtime.events === null) {
        throw new ConfigurationException(
          entityName,
          "realtime.events",
          `expected an object, got ${JSON.stringify(realtime.events)}`,
        );
      }
      for (const [id, value] of Object.entries(realtime.events)) {
        const path = `realtime.events.${id}`;
        if (!REALTIME_EVENT_IDS.has(id)) {
          throw new ConfigurationException(
            entityName,
            path,
            `unknown realtime event id ${JSON.stringify(id)} — expected one of ${[...REALTIME_EVENT_IDS].join(", ")}`,
          );
        }
        bool(path, value);
      }
    }
    if (realtime.subscribableFields !== undefined) {
      const selector = realtime.subscribableFields;
      const invalid = Array.isArray(selector)
        ? selector.some((field) => typeof field !== "string")
        : typeof selector !== "object" ||
          selector === null ||
          !Array.isArray((selector as { exclude?: unknown }).exclude);
      if (invalid) {
        throw new ConfigurationException(
          entityName,
          "realtime.subscribableFields",
          `expected a string array or { exclude: string[] }, got ${JSON.stringify(selector)}`,
        );
      }
    }
    if (realtime.onPublishError !== undefined && typeof realtime.onPublishError !== "function") {
      throw new ConfigurationException(
        entityName,
        "realtime.onPublishError",
        `expected a function, got ${JSON.stringify(realtime.onPublishError)}`,
      );
    }
  }

  if (settings.arrayMutation !== false) {
    const arrayMutation = settings.arrayMutation;
    if (typeof arrayMutation !== "object" || arrayMutation === null) {
      throw new ConfigurationException(
        entityName,
        "arrayMutation",
        `expected false or { strategy: "replace" | "resource" | "jsonPatch" }, got ${JSON.stringify(arrayMutation)}`,
      );
    }
    if (
      arrayMutation.strategy !== undefined &&
      arrayMutation.strategy !== "replace" &&
      arrayMutation.strategy !== "resource" &&
      arrayMutation.strategy !== "jsonPatch"
    ) {
      throw new ConfigurationException(
        entityName,
        "arrayMutation.strategy",
        `expected unset, "replace", "resource", or "jsonPatch", got ${JSON.stringify(arrayMutation.strategy)}`,
      );
    }
  }

  for (const [id, value] of Object.entries(settings.operations)) {
    const path = `operations.${id}`;
    if (!(id in STANDARD_OPERATIONS)) {
      throw new ConfigurationException(
        entityName,
        path,
        `unknown operation id ${JSON.stringify(id)} — expected one of ${Object.keys(STANDARD_OPERATIONS).join(", ")}`,
      );
    }
    bool(path, value);
  }

  bool("authorization.required", settings.authorization.required);
}
