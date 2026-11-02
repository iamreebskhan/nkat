/**
 * Writing X12 (0120): cleaning values, amounts, the fixed-width ISA, and the
 * envelope's counts. A broken envelope is the one mistake a clearinghouse
 * rejects whole (TA1), before it looks at a single claim.
 */
import { describe, expect, it } from "vitest";

import { readX12 } from "../x12-read";
import {
  closeTransactionSet,
  seg,
  transactionSetControlNumber,
  wrapInterchange,
  x12Amount,
  x12Id,
  x12Text,
} from "../x12-write";

describe("x12Text", () => {
  it("never lets a delimiter through, folds accents and upper-cases", () => {
    expect(x12Text("José O'Brien*Jr: ~^")).toBe("JOSE O'BRIEN JR");
    expect(x12Text("  St. Mary’s   Hospice — East ")).toBe("ST. MARY'S HOSPICE - EAST");
    expect(x12Text("a\tb\nc")).toBe("A B C");
  });

  it("cuts to a length without a trailing space", () => {
    expect(x12Text("ABCDE FGHIJ", 6)).toBe("ABCDE");
  });

  it("x12Id keeps letters and digits only", () => {
    expect(x12Id("1eg4-te5-mk72")).toBe("1EG4TE5MK72");
  });
});

describe("x12Amount", () => {
  it("drops leading and trailing zeros as X12's decimal type asks", () => {
    expect(x12Amount(12500)).toBe("125");
    expect(x12Amount(12550)).toBe("125.5");
    expect(x12Amount(12555)).toBe("125.55");
    expect(x12Amount(5)).toBe("0.05");
    expect(x12Amount(0)).toBe("0");
  });

  it("refuses a fraction of a cent or a negative", () => {
    expect(() => x12Amount(1.5)).toThrow();
    expect(() => x12Amount(-1)).toThrow();
  });
});

describe("seg", () => {
  it("drops trailing empty elements and joins composites with a colon", () => {
    expect(seg("NM1", "41", "2", "PALLIO", "", "", "", "", "46", "AV1", "", "")).toBe("NM1*41*2*PALLIO*****46*AV1");
    expect(seg("SV1", ["HC", "99350", "", ""], "150", "UN", "1")).toBe("SV1*HC:99350*150*UN*1");
  });

  it("throws on a value that still carries a delimiter (a bug, never shipped)", () => {
    expect(() => seg("NM1", "A*B")).toThrow(/delimiter/);
    expect(() => seg("NM1", "A:B")).toThrow(/delimiter/);
    expect(() => seg("SV1", ["HC", "99~350"])).toThrow(/delimiter/);
  });
});

describe("wrapInterchange", () => {
  const set = closeTransactionSet([seg("ST", "837", "0001", "005010X222A1"), seg("BHT", "0019", "00", "R1")], "0001");
  const env = {
    senderQualifier: "ZZ",
    senderId: "AV09311993",
    receiverQualifier: "01",
    receiverId: "030240928",
    gsSenderCode: "AV09311993",
    gsReceiverCode: "030240928",
    usage: "T" as const,
    interchangeControlNumber: 123,
    groupControlNumber: 456,
    functionalId: "HC" as const,
    version: "005010X222A1",
    now: new Date("2026-10-29T14:05:00Z"),
  };

  it("writes a 106-character ISA with padded IDs and the UTC clock", () => {
    const file = wrapInterchange(env, [set]);
    const isa = file.slice(0, 106);
    expect(isa).toBe("ISA*00*          *00*          *ZZ*AV09311993     *01*030240928      *261029*1405*^*00501*000000123*1*T*:~");
    expect(file).not.toMatch(/[\r\n]/);
  });

  it("closes the set and the group with the right counts", () => {
    const file = wrapInterchange(env, [set, set]);
    const doc = readX12(file);
    const tags = doc.segments.map((s) => s.tag);
    expect(tags.filter((t) => t === "ST")).toHaveLength(2);
    const se = doc.segments.find((s) => s.tag === "SE")!;
    expect(se.elements[1]).toBe("3"); // ST, BHT, SE
    const ge = doc.segments.find((s) => s.tag === "GE")!;
    expect(ge.elements.slice(1)).toEqual(["2", "456"]);
    const iea = doc.segments.find((s) => s.tag === "IEA")!;
    expect(iea.elements.slice(1)).toEqual(["1", "000000123"]);
    const gs = doc.segments.find((s) => s.tag === "GS")!;
    expect(gs.elements.slice(1)).toEqual(["HC", "AV09311993", "030240928", "20261029", "1405", "456", "X", "005010X222A1"]);
  });

  it("refuses control numbers X12 cannot carry", () => {
    expect(() => wrapInterchange({ ...env, interchangeControlNumber: 0 }, [set])).toThrow();
    expect(() => wrapInterchange({ ...env, groupControlNumber: 1_000_000_000 }, [set])).toThrow();
  });

  it("ST02 has four digits at least", () => {
    expect(transactionSetControlNumber(1)).toBe("0001");
    expect(transactionSetControlNumber(12345)).toBe("12345");
  });
});

describe("readX12", () => {
  it("reads the file's own delimiters and ignores line breaks between segments", () => {
    const file = "ISA|00|          |00|          |ZZ|SENDER         |ZZ|RECEIVER       |261029|1405|^|00501|000000007|0|P|>!\r\nGS|FA|R|S|20261029|1405|7|X|005010X231A1!\nST|999|0001|005010X231A1!SE|2|0001!GE|1|7!IEA|1|000000007!";
    const doc = readX12(file);
    expect(doc.delimiters).toEqual({ element: "|", repetition: "^", component: ">", segment: "!" });
    expect(doc.interchange.controlNumber).toBe(7);
    expect(doc.transactionTypes).toEqual(["999"]);
    expect(doc.version).toBe("005010X231A1");
  });

  it("reads an ISA a sender failed to pad to its fixed width", () => {
    const file = "ISA*00*   *00*   *01*030240928   *ZZ*AV09311993*031204*1109*U*00501*000090091*0*P*:~GS*FA*030240928*AV01101957*20031204*1109*80180*X*005010X231A1~ST*999*0001*005010X231A1~SE*2*0001~GE*1*80180~IEA*1*000090091~";
    const doc = readX12(file);
    expect(doc.delimiters.component).toBe(":");
    expect(doc.delimiters.segment).toBe("~");
    // ISA11 "U" is the 4010 value, not a separator.
    expect(doc.delimiters.repetition).toBe("^");
    expect(doc.interchange.controlNumber).toBe(90091);
  });

  it("refuses a file that is not X12", () => {
    expect(() => readX12("hello")).toThrow(/no ISA/);
  });
});
