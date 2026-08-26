/**
 * The incoming request as a principal extractor sees it: a property bag.
 * `@kavo/nest` serves under both Express and Fastify and names neither, so
 * this is deliberately structural — `user` is spelled out because that is
 * where Passport, `@nestjs/passport` and most hand-rolled guards leave the
 * authenticated caller, and the index signature is what lets an extractor
 * read any other property instead.
 *
 * An extractor that wants its framework's own request type casts to it
 * (`(request) => (request as unknown as Request).user`): a parameter typed
 * to one framework's class would make the option unassignable from the
 * other's.
 */
export interface KavoPrincipalRequest {
  readonly user?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Pulls the already-authenticated caller off one incoming request. Called
 * once per request from inside the generated route handler; whatever it
 * returns becomes `KavoContext.principal` for that request and nothing
 * else. Kavo never inspects, validates or caches the value — the principal
 * is carried, never judged (doc 01 §8), and authentication itself stays
 * the app's (a guard's, a middleware's) job.
 *
 * It runs on the request path, so keep it synchronous and cheap: a lookup
 * off an object a guard already populated, not a token verification or a
 * database read. Throwing from it fails the request as an unhandled error
 * (a 500 problem-details document), which is deliberate — an extractor
 * that cannot answer must not quietly answer `null`.
 */
export type KavoPrincipalExtractor = (request: KavoPrincipalRequest) => unknown;

/**
 * `KavoModule`'s `principal` option: `true` reads `request.user`, a
 * function reads whatever it likes, and `false` (or leaving the option
 * unset) leaves `KavoContext.principal` `null` — what every app that never
 * configured one already gets.
 */
export type KavoPrincipalOption = boolean | KavoPrincipalExtractor;

/** What `principal: true` means. */
const principalFromRequestUser: KavoPrincipalExtractor = (request) => request.user;

/**
 * @internal The module option as the binder needs it: one function, or
 * `undefined` for "no extractor configured", which the generated handlers
 * read as `options: null` — the request an unconfigured route sends, so an
 * app that never opts in keeps a `null` principal.
 */
export function resolvePrincipalExtractor(option: KavoPrincipalOption | undefined): KavoPrincipalExtractor | undefined {
  if (option === undefined || option === false) {
    return undefined;
  }
  return option === true ? principalFromRequestUser : option;
}
