/**
 * GET /api/offline/ping — whether this server can be reached, for the offline
 * indicator. navigator.onLine says only that the device has a network; a
 * tablet on a home's Wi-Fi with no internet still reports true. Nothing is
 * read and nothing is said: a 204, never cached.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
