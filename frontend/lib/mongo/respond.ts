import { NextResponse } from "next/server";

import { MongoUnavailableError } from "./client";
import { ReplayUnavailableError } from "./replay";

/**
 * Turn a failed read into an HONEST error response.
 *
 * The contract these routes exist to keep is that the page shows real data or nothing. So a
 * failure returns a 503 the UI renders as an explicit "couldn't read the capture" state —
 * never a fallback series, never a stale hardcoded number, never a zero that reads like a
 * price. Callers distinguish this from an empty-but-successful read by the `error` key.
 *
 * Driver errors are reduced to their class name before they reach the response. A Mongo
 * connection error's `message` embeds the connection string's host and, on an auth failure,
 * can echo the user — so it is never forwarded to a client or written to a log.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof MongoUnavailableError || err instanceof ReplayUnavailableError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  return NextResponse.json(
    {
      error:
        "The capture database could not be read. Nothing is shown rather than " +
        "invented or stale figures.",
    },
    { status: 503 },
  );
}

/** Parse a required positive-integer query param. Returns `null` when absent or malformed. */
export function intParam(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
