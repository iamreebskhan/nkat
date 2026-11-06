/**
 * Every patient a picker offers, read a page of 200 at a time (GET
 * /api/patients's limit). The booking form and the record-access filter asked
 * for one page, so from the 201st patient under care on (by acuity, then name)
 * a patient could not be picked: not booked from the schedule, not even when
 * arriving from their own chart's "Schedule visit".
 */

export interface PickerPatient {
  id: string;
  firstName: string;
  lastName: string;
}

const PAGE = 200;
/** A stop for a list that never ends, far above any practice's census. */
const MAX_PATIENTS = 20_000;

export async function fetchAllPatients(
  fetcher: (url: string) => Promise<{ success: boolean; error?: string; data?: { rows?: PickerPatient[]; total?: number } }> = (
    url,
  ) => fetch(url).then((r) => r.json()),
): Promise<PickerPatient[]> {
  const out: PickerPatient[] = [];
  for (let offset = 0; offset < MAX_PATIENTS; offset += PAGE) {
    const d = await fetcher(`/api/patients?limit=${PAGE}&offset=${offset}`);
    if (!d.success) throw new Error(d.error ?? "The patient list could not be loaded.");
    const rows = d.data?.rows ?? [];
    out.push(...rows.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName })));
    if (rows.length < PAGE || out.length >= (d.data?.total ?? 0)) break;
  }
  return out;
}
