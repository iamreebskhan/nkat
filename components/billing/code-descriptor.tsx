/**
 * A code's descriptor, or, for a CPT® code on a deployment without Pallio's
 * AMA licence, a plain statement of why it is not shown (audit R21).
 *
 * The server now gates every path (the Rulebook, the code picker, the claim
 * lists) and hands back AMA_PLACEHOLDER in place of the licensed text. The
 * picker and the lists used to show the full text while the Rulebook and the
 * sidebar badge said it was redacted. The Rulebook's tooltip also sent an org
 * admin to a Settings page with no licence control, because the licence
 * belongs to the deployment, not the org.
 *
 * `compact` is for places already inside a button (the picker's options): an
 * ⓘ button there would be an invalid nested control, so the explanation goes
 * in a title instead.
 */
import { InfoTip } from "@/components/ui/info-tip";
import { isAmaPlaceholder } from "@/lib/features/billing/code-pure";
import { cn } from "@/lib/utils";

export const AMA_DESCRIPTOR_NOTE =
  "CPT® descriptors are licensed by the AMA. They appear once Pallio's AMA licence is active on this deployment; codes, coverage and rules are unaffected.";

export function CodeDescriptor({
  text,
  compact = false,
  className,
}: {
  text: string | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  if (!text) return null;
  if (!isAmaPlaceholder(text)) return <span className={className}>{text}</span>;
  return (
    <span
      className={cn(className, "italic text-slate-400")}
      title={compact ? AMA_DESCRIPTOR_NOTE : undefined}
    >
      Descriptor licensed by the AMA
      {!compact && (
        <>
          {" "}
          <InfoTip label="About AMA descriptors">{AMA_DESCRIPTOR_NOTE}</InfoTip>
        </>
      )}
    </span>
  );
}
