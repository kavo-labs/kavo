import type { KavoAppContext } from "@kavo/core";

/**
 * The incoming request as an app-context extractor sees it: a property bag.
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
export interface KavoAppContextRequest {
  readonly user?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Builds the application's request-scoped context off one incoming request.
 * Called once per request from inside the generated route handler; whatever
 * it returns becomes `KavoContext.app` for that request and nothing else.
 * Kavo never inspects, validates or caches the value — the app context is
 * carried, never judged, and authentication itself stays the app's (a
 * guard's, a middleware's) job.
 *
 * It runs on the request path, so keep it synchronous and cheap: a read off
 * an object a guard already populated, not a token verification or a
 * database read. Throwing from it fails the request as an unhandled error
 * (a 500 problem-details document), which is deliberate — an extractor that
 * cannot answer must not quietly answer an empty context.
 *
 * Return **plain, shallow data** — the fields policies and custom operation
 * handlers read, not `request.user` passed straight through. With the result cache
 * on, `KavoContext.app` is canonicalized into the cache key: a framework/ORM
 * object with prototype getters hashes the same for every caller (bucket
 * collapse) and a cyclic one throws a `RangeError` on the read.
 */
export type KavoAppContextExtractor = (request: KavoAppContextRequest) => KavoAppContext;
