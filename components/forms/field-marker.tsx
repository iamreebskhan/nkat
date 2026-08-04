/**
 * The required / recommended / optional marker that sits next to a field label.
 *
 * Client walkthrough [00:34]–[00:44], and the frame that settles it: `087s`
 * shows the Insurance step with EVERY field reading "(optional)" — payer,
 * member ID, group number, coverage effective. That is the complaint. The fix
 * isn't to add "(optional)" everywhere; it's to make the marker honest, so a
 * field that matters doesn't wear the same badge as one that doesn't.
 *
 * This lives on its own because several screens grew their own local `Field`
 * component before the shared one existed. Rather than risk re-laying-out those
 * forms, they all render THIS — so the vocabulary stays identical even where
 * the layout doesn't.
 */
export function FieldMarker({
  required,
  optional,
  recommended,
}: {
  required?: boolean;
  optional?: boolean;
  /** Not required to save, but the feature won't work without it. */
  recommended?: boolean;
}) {
  if (required) {
    return (
      <>
        <span className="text-red-600 ml-0.5" aria-hidden>
          *
        </span>
        <span className="sr-only"> required</span>
      </>
    );
  }
  if (optional) {
    return <span className="text-slate-500 font-normal ml-1">(optional)</span>;
  }
  if (recommended) {
    return (
      <span className="text-[var(--color-brand-700)] font-normal ml-1">(recommended)</span>
    );
  }
  return null;
}
