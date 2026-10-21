/**
 * The CPT/HCPCS codes on a claim, each with what it means.
 *
 * Descriptors come from the rulebook-fed `code` table via listSuperbills. The
 * list screens used to show a date and a dollar amount only, although every
 * row already carried its codes — so what a claim billed was invisible until
 * someone opened it.
 *
 * A code with no descriptor is still shown, flagged. Dropping it would hide
 * exactly the claim a biller most needs to look at.
 */
import { CodeDescriptor } from "@/components/billing/code-descriptor";

export function CodeList({
  codes,
  descriptors,
}: {
  codes: string[] | null | undefined;
  descriptors?: Record<string, string | null>;
}) {
  if (!codes || codes.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <ul className="space-y-1">
      {codes.map((c) => {
        const d = descriptors?.[c] ?? null;
        return (
          <li key={c} className="leading-tight">
            <span className="font-mono text-xs text-slate-900">{c}</span>
            {d ? (
              // compact: these lists sit in scroll containers that clip the ⓘ
              // panel, so the explanation rides on a title instead.
              <CodeDescriptor text={d} compact className="block text-[11px] text-slate-500" />
            ) : (
              <span className="block text-[11px] text-amber-700">Not in the code reference</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
