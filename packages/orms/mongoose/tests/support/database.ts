import mongoose, { type Connection } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * One in-memory MongoDB per spec file, reached through a dedicated
 * `createConnection` handle rather than the global `mongoose.connection`.
 *
 * The dedicated connection is what keeps spec files from colliding: model
 * names are registered *per connection*, so re-declaring `Author` in a
 * second file would throw `OverwriteModelError` against the global one. It
 * also exercises the multi-database path — `connection.models` is exactly
 * what `createInfrastructure` resolves relation targets through.
 */
export interface TestDatabase {
  readonly connection: Connection;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const server = await MongoMemoryServer.create();
  const connection = mongoose.createConnection(server.getUri(), { dbName: "kavo" });
  await connection.asPromise();
  return {
    connection,
    async stop() {
      await connection.close();
      await server.stop();
    },
  };
}

/** Drop every document in the connection, keeping indexes intact. */
export async function clearCollections(connection: Connection): Promise<void> {
  await Promise.all(Object.values(connection.models).map((model) => model.deleteMany({})));
}

/**
 * Await index construction for the given models. Mongoose builds indexes in
 * the background, so a `unique: true` test that skips this races the index
 * into existence and sees no conflict.
 */
export async function ensureIndexes(...models: readonly { init(): Promise<unknown> }[]): Promise<void> {
  await Promise.all(models.map((model) => model.init()));
}

/** Capture a rejection so both its class and its stable code can be asserted. */
export async function rejectionOf(promise: Promise<unknown>): Promise<{ code?: unknown } & Error> {
  // The "it resolved" failure is raised *outside* the catch — thrown from
  // inside the `try`, this function's own handler would swallow it and hand
  // the caller a bogus error to assert against.
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (error) {
    return error as { code?: unknown } & Error;
  }
  if (resolved) {
    throw new Error("expected the promise to reject, but it resolved");
  }
  throw new Error("unreachable");
}
