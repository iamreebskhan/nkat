/**
 * Pallio API response envelope.
 *
 * Source: pallio_complete_vision_v3 §18.2.
 *
 *   { success: boolean; data: T | null; error: string | null }
 *
 * Every API route returns this shape — no exceptions. Frontend code
 * unwraps the envelope in one place (TanStack Query queryFn) so route
 * handlers stay terse.
 */
import { type NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";

import { reportError } from "@/lib/observability/sentry";

export type ApiResponse<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
};

export function ok<T>(data: T, init?: { status?: number }): NextResponse<ApiResponse<T>> {
  return NextResponse.json(
    { success: true, data, error: null },
    { status: init?.status ?? 200 },
  );
}

export function fail(
  error: string,
  init?: { status?: number },
): NextResponse<ApiResponse<null>> {
  return NextResponse.json(
    { success: false, data: null, error },
    { status: init?.status ?? 400 },
  );
}

/**
 * Throw from a service when a row that the caller referenced doesn't
 * exist for this tenant. Route handlers catch this and respond 404 —
 * matters because RLS-filtered UPDATEs / DELETEs silently affect 0
 * rows when the target row belongs to a different org, and we need
 * the API to say "not found" instead of "ok".
 *
 * Using "not found" (not "forbidden") on purpose: it avoids leaking
 * the existence of cross-tenant rows.
 */
export class NotFoundError extends Error {
  constructor(message: string = "Not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Raised when an action would exceed the org's paid seat count.
 * Maps to HTTP 402 (Payment Required) — the UI shows an upgrade CTA.
 */
export class SeatLimitError extends Error {
  constructor(message: string = "Seat limit reached for your plan.") {
    super(message);
    this.name = "SeatLimitError";
  }
}

/**
 * Throw from a service when the CALLER's input is at fault and the
 * message is written for the user's eyes (unknown payer, illegal status
 * transition, non-member assignee…). Routes echo it at 422. Anything a
 * service throws that is NOT one of the typed errors is treated as an
 * internal fault: reported to the dashboard and returned as a generic
 * 500 — raw driver/Prisma messages must never reach a client.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Format check for dynamic route params that must be UUIDs. */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * Guard a dynamic route param that feeds a `::uuid` cast. Returns a 404
 * envelope for malformed ids (a garbage id can't exist, and existence is
 * never leaked) — without this, Postgres 22P02 surfaced Prisma's
 * raw-query error text to the client. Use like parseJson:
 *
 *   const bad = requireUuidParam(id);
 *   if (bad) return bad;
 */
export function requireUuidParam(v: string): NextResponse<ApiResponse<null>> | null {
  return isUuid(v) ? null : fail("Not found.", { status: 404 });
}

/**
 * Helper for routes — wraps a service call. Typed domain errors map to
 * their status with the message echoed (NotFoundError → 404,
 * SeatLimitError → 402, ValidationError → 422); everything else is an
 * internal fault: reported to the error dashboard (PHI-scrubbed, no-op
 * without SENTRY_DSN) and genericized to 500.
 */
export function handleServiceError(err: unknown): NextResponse<ApiResponse<null>> {
  if (err instanceof NotFoundError) return fail(err.message, { status: 404 });
  if (err instanceof SeatLimitError) return fail(err.message, { status: 402 });
  if (err instanceof ValidationError) return fail(err.message, { status: 422 });
  reportError(err, { source: "handleServiceError" });
  return fail("Something went wrong. Try again or contact support.", { status: 500 });
}

/**
 * Parse the request body against a Zod schema. Returns the parsed
 * value or a 400 envelope. Use in every API route that accepts JSON.
 *
 * Example:
 *   const body = await parseJson(req, RuleLookupRequest);
 *   if (body instanceof NextResponse) return body;
 *   // body is fully typed from here.
 */
export async function parseJson<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
): Promise<T | NextResponse<ApiResponse<null>>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("Request body must be valid JSON.", { status: 400 });
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return fail(formatZodError(result.error), { status: 422 });
  }
  return result.data;
}

function formatZodError(err: ZodError): string {
  // Surface the first issue with a path — sufficient for an end-user
  // facing error. Full structured errors stay in server logs.
  const first = err.issues[0];
  if (!first) return "Invalid request body.";
  const path = first.path.length > 0 ? first.path.join(".") + ": " : "";
  return `${path}${first.message}`;
}

/**
 * Parse search params against a Zod schema. Useful for GET routes
 * with filtering (e.g. `/api/patients?payerId=…&state=OH`).
 */
export function parseSearchParams<T>(
  url: URL,
  schema: ZodSchema<T>,
): T | NextResponse<ApiResponse<null>> {
  const obj = Object.fromEntries(url.searchParams.entries());
  const result = schema.safeParse(obj);
  if (!result.success) {
    return fail(formatZodError(result.error), { status: 422 });
  }
  return result.data;
}
