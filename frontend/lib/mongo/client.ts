import { MongoClient, type Db } from "mongodb";

/**
 * The one MongoDB connection this server instance uses.
 *
 * Serverless (Vercel) builds a fresh module instance per cold start and then reuses it
 * across many invocations. Creating a `MongoClient` per request would open a new pool
 * every time and exhaust Atlas's connection limit, so the client is cached at MODULE
 * scope — the same discipline `app/api/rpc/route.ts` uses for its limiter and cache.
 *
 * In dev, Next.js hot-reloads modules on every edit, which would leak a pool per reload;
 * the cache is therefore parked on `globalThis`, which survives HMR.
 *
 * `MONGODB_URI` is read from the server environment and never re-exported. It must NEVER
 * be exposed as `NEXT_PUBLIC_*` — that would ship the database credentials in the browser
 * bundle. Nothing in this module logs or embeds the URI, including in its errors.
 */

/** Raised when the database cannot be reached or is not configured. Never carries the URI. */
export class MongoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MongoUnavailableError";
  }
}

const DEFAULT_DB = "gorilla";

// Fail fast: a hanging read is worse than an honest error state on a demo page.
const CONNECT_TIMEOUT_MS = 8000;

interface MongoCache {
  client: MongoClient | null;
  promise: Promise<MongoClient> | null;
}

const globalCache = globalThis as typeof globalThis & { __gorillaMongo?: MongoCache };
const cache: MongoCache = (globalCache.__gorillaMongo ??= { client: null, promise: null });

function connect(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new MongoUnavailableError(
      "MONGODB_URI is not set on the server. Set it in the deployment environment " +
        "(server-side only — never NEXT_PUBLIC_).",
    );
  }
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    // Serverless: many short-lived instances, each needing only a couple of sockets.
    maxPoolSize: 5,
    minPoolSize: 0,
  });
  return client.connect();
}

/** The shared, connected database handle. Concurrent callers share one in-flight connect. */
export async function getDb(): Promise<Db> {
  if (cache.client) return cache.client.db(process.env.MONGODB_DB || DEFAULT_DB);
  if (!cache.promise) {
    // A failed connect must not poison the cache — clear the promise so the next
    // request retries instead of replaying the same rejection forever.
    cache.promise = connect().catch((err: unknown) => {
      cache.promise = null;
      throw new MongoUnavailableError(
        `Could not connect to MongoDB: ${err instanceof Error ? err.name : "unknown error"}`,
      );
    });
  }
  cache.client = await cache.promise;
  return cache.client.db(process.env.MONGODB_DB || DEFAULT_DB);
}
