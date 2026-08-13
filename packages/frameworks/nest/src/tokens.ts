import type { ClassRef, DefaultKavoService } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import type { KavoPrincipalExtractor, KavoPrincipalRequest } from "./principal.js";

/** DI token of the Kavo root instance created by `KavoModule.forRoot`. */
export const KAVO_INSTANCE = Symbol("KAVO_INSTANCE");

/** DI token of the resolved `KavoModuleOptions`. */
export const KAVO_MODULE_OPTIONS = Symbol("KAVO_MODULE_OPTIONS");

/** Reflect metadata key the `@Kavo` decorator writes on controllers. */
export const KAVO_CONTROLLER_METADATA = "kavo:controller";

/** Reflect metadata key the `@Override` method decorator writes. */
export const KAVO_OVERRIDE_METADATA = "kavo:override";

/**
 * Reflect metadata key the `@Kavo` decorator writes on controllers: the
 * routes whose conditional-request Swagger docs (ADR-0020) couldn't be
 * decided at decoration time, for `KavoModule`'s discovery binder to finish
 * once the entity's config is fully resolved — see
 * `applyConditionalRequestDocs`'s doc comment in `swagger.ts`.
 */
export const KAVO_CONDITIONAL_DOCS_METADATA = "kavo:conditionalDocs";

/** Property the generated route methods read the injected service from. */
export const KAVO_SERVICE_PROPERTY = "__kavoService";

/**
 * Property the generated route methods read the configured principal
 * extractor from — bound onto the controller instance by the same
 * `KavoModule` discovery pass that binds the service. Written on every
 * `@Kavo` controller that pass finds, `undefined` included, so that its
 * *presence* means "this controller was bound" and its absence means
 * "this object never was" (`boundKavoPrincipal` reads exactly that
 * difference). Instance-scoped for the same reason the
 * service is: the controller *class* is process-wide, so a second app in
 * the same process (every `@kavo/nest` test file) would otherwise inherit
 * the first one's module options.
 */
export const KAVO_PRINCIPAL_PROPERTY = "__kavoPrincipal";

const serviceTokens = new Map<ClassRef, string>();

/**
 * The injection token of the `KavoService` bound to one entity. Stable per
 * entity class, usable in consumer constructors:
 * `@Inject(getKavoServiceToken(UserEntity))`.
 */
export function getKavoServiceToken(entity: ClassRef): string {
  let token = serviceTokens.get(entity);
  if (token === undefined) {
    token = `KAVO_SERVICE_${entity.name}`;
    serviceTokens.set(entity, token);
  }
  return token;
}

/**
 * Reads the `KavoService` `KavoModule`'s discovery binder already bound onto
 * a `@Kavo`-decorated controller instance — the typed way for the
 * controller's own methods (an `@Override`, or a fully custom native route)
 * to reach it, with no separate constructor injection needed.
 */
export function boundKavoService<Entity extends object>(controller: object): DefaultKavoService<Entity> {
  return (controller as Record<string, unknown>)[KAVO_SERVICE_PROPERTY] as DefaultKavoService<Entity>;
}

/**
 * Runs the `principal` extractor `KavoModule` was configured with against
 * one incoming request — the counterpart of `boundKavoService` for the
 * methods Kavo does not generate. A generated route already does this for
 * itself; an `@Override`'d method or a fully custom native route reaches
 * the engine on its own and so must pass the principal on itself, either
 * as `service.<op>(…, { principal })` or through
 * `service.engine.execute({ …, options: { principal } })`.
 *
 * Declare the request as the trailing parameter of an `@Override`'d method
 * (reads: `(id?, query, preconditions, request)`; writes:
 * `(id?, body?, preconditions, request)`); a fully custom route declares
 * its own `@Req()`. `null` when no extractor is configured — the same
 * answer `KavoContext.principal` gives then.
 *
 * Passed an object the binder never visited (anything not `@Kavo`-decorated
 * — a plain provider, a `BaseKavoGraphQLController` subclass) it throws
 * rather than answering `null`. The two are indistinguishable to the
 * caller otherwise, and a silently anonymous principal is exactly the bug
 * this wiring exists to end (issue #142); the binder writes the property
 * on every `@Kavo` controller it finds, extractor or not, so its presence
 * is what separates "not configured" from "wrong object".
 */
export function boundKavoPrincipal(controller: object, request: KavoPrincipalRequest): unknown {
  if (!(KAVO_PRINCIPAL_PROPERTY in controller)) {
    const name = controller.constructor.name;
    throw new ConfigurationException(
      name,
      "principal",
      `'${name}' was never bound by KavoModule — boundKavoPrincipal reads the extractor the ` +
        "discovery pass writes onto a @Kavo-decorated controller instance; a class without @Kavo(Entity) " +
        "must read the request itself",
    );
  }
  const extractPrincipal = (controller as Record<string, unknown>)[KAVO_PRINCIPAL_PROPERTY] as
    KavoPrincipalExtractor | undefined;
  return extractPrincipal === undefined ? null : extractPrincipal(request);
}
