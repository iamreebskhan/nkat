/**
 * The app's mark for its icons: a teal "P" on the sidebar's slate, drawn for
 * next/og's ImageResponse (inline styles only). Shared by the home-screen
 * icon and the manifest's sizes so they cannot drift apart.
 */
export function PallioMark({ size }: { size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f172a",
        color: "#14b8a6",
        fontSize: Math.round(size * 0.62),
        fontWeight: 700,
        fontFamily: "sans-serif",
      }}
    >
      P
    </div>
  );
}
