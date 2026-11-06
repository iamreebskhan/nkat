/**
 * The authenticator link as a QR code to scan (0121). Drawn in the browser by
 * lib/features/auth/qr-code.ts: the link holds the account's secret, so it is
 * never sent to a QR service or anywhere else. Black on white whatever the
 * page's colours, with the quiet zone scanners need.
 */
"use client";

import { useMemo } from "react";

import { encodeQr, qrSvgPath } from "@/lib/features/auth/qr-code";

/** Screen pixels per module: about 230 px across for a usual link. */
const MODULE_PX = 4;

export function QrCodeImage({ text, label }: { text: string; label: string }) {
  const code = useMemo(() => encodeQr(text), [text]);
  const span = code.size + 8;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${span} ${span}`}
      width={span * MODULE_PX}
      height={span * MODULE_PX}
      shapeRendering="crispEdges"
      className="rounded border border-slate-200"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={qrSvgPath(code)} fill="#000000" />
    </svg>
  );
}
