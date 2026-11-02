/**
 * The web app manifest: what lets Pallio be added to an iPad's home screen and
 * open full screen (Level-1 doc:33; Mark: the practice's current EHR runs on
 * iPads, so we design for the iPad). Opening offline is the service worker's
 * (public/sw.js).
 */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pallio",
    short_name: "Pallio",
    description: "Palliative-care EMR: the chart, the visit note and the bill.",
    start_url: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#0f172a",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
