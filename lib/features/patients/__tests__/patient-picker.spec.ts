/**
 * The booking form and the record-access filter offer every patient, read a
 * page of 200 at a time. One page used to be all they read, so the 201st
 * patient under care could not be booked from the schedule.
 */
import { describe, expect, it } from "vitest";

import { fetchAllPatients, type PickerPatient } from "../patient-picker";

const people = (n: number): PickerPatient[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, firstName: `F${i}`, lastName: `L${i}` }));

function api(all: PickerPatient[]) {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    const q = new URL(url, "http://x");
    const limit = Number(q.searchParams.get("limit"));
    const offset = Number(q.searchParams.get("offset"));
    return { success: true, data: { rows: all.slice(offset, offset + limit), total: all.length } };
  };
  return { asked, fetcher };
}

describe("fetchAllPatients", () => {
  it("reads every page: 450 patients in three requests, the 201st and the last among them", async () => {
    const { asked, fetcher } = api(people(450));
    const rows = await fetchAllPatients(fetcher);
    expect(rows).toHaveLength(450);
    expect(rows[200]!.id).toBe("p200");
    expect(rows.at(-1)!.id).toBe("p449");
    expect(asked).toEqual([
      "/api/patients?limit=200&offset=0",
      "/api/patients?limit=200&offset=200",
      "/api/patients?limit=200&offset=400",
    ]);
  });

  it("CONTROL: asks once for a practice of fewer than 200, and once more for exactly 200", async () => {
    const small = api(people(37));
    expect(await fetchAllPatients(small.fetcher)).toHaveLength(37);
    expect(small.asked).toHaveLength(1);
    const exact = api(people(200));
    expect(await fetchAllPatients(exact.fetcher)).toHaveLength(200);
    expect(exact.asked).toHaveLength(1);
  });

  it("throws the API's refusal rather than returning part of the list", async () => {
    let n = 0;
    const fetcher = async () =>
      ++n === 1
        ? { success: true, data: { rows: people(200), total: 300 } }
        : { success: false, error: "Permission denied" };
    await expect(fetchAllPatients(fetcher)).rejects.toThrow("Permission denied");
  });
});
