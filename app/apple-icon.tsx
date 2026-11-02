/**
 * The iPad home-screen icon (apple-touch-icon), drawn by next/og: what an NP
 * sees after "Add to Home Screen" (app/manifest.ts).
 */
import { ImageResponse } from "next/og";

import { PallioMark } from "@/components/offline/pallio-mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<PallioMark size={180} />, { ...size });
}
