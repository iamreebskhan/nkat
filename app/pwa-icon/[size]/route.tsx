/**
 * GET /pwa-icon/192 and /pwa-icon/512 — the manifest's icons, drawn by
 * next/og rather than kept as files (app/manifest.ts).
 */
import { ImageResponse } from "next/og";

import { PallioMark } from "@/components/offline/pallio-mark";

const SIZES = new Set([192, 512]);

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }): Promise<Response> {
  const size = Number((await ctx.params).size);
  if (!SIZES.has(size)) return new Response(null, { status: 404 });
  return new ImageResponse(<PallioMark size={size} />, { width: size, height: size });
}
