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
