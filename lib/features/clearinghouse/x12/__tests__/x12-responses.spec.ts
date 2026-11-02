/**
 * Reading what comes back (0120): the 999 and TA1, the 277CA and 277, the
 * 271, and telling files apart. The 999 and 277CA samples are Availity's own
 * (Batch EDI Standard Companion Guide, 2023-04-14, pp. 87, 116-117); the
 * others follow the TR3s.
 */
import { describe, expect, it } from "vitest";

import { buildClaimStatus276, buildEligibility270, traceOriginator } from "../x12-270-276";
import { hospiceElectionText, parse271, verificationResult } from "../x12-271";
import { claimState277, isRejection, parse277 } from "../x12-277";
import { groupAckState, parse999, setAckState } from "../x12-ack";
import { classifyClearinghouseFile } from "../x12-classify";
import { ackErrorNextStep, describeAckError, describeStatus, NEXT_STEPS, plainStatus, rejectionNextStep } from "../x12-codes";
import { readX12 } from "../x12-read";
import { wrapInterchange } from "../x12-write";

const ISA_FROM_AVAILITY = "ISA*00*          *00*          *01*030240928      *ZZ*AV09311993     *031204*1109*^*00501*000090091*0*P*:~";

const REJECTED_999 =
  ISA_FROM_AVAILITY +
  "TA1*000001732*031204*1101*A*000~" +
  "GS*FA*030240928*AV01101957*20031204*1109*80180*X*005010X231A1~" +
  "ST*999*0001*005010X231A1~" +
  "AK1*HC*17321*005010X223A2~" +
  "AK2*837*000000001*005010X223A2~" +
  "IK3*CL1*24*2300*8~" +
  "CTX*CLM01:393931D_1310~" +
  "IK4*2*1314*5*AA~" +
  "IK5*R*5~" +
  "AK9*R*1*1*0~" +
  "SE*8*0001~GE*1*80180~IEA*1*000090091~";

const ACCEPTED_999 =
  ISA_FROM_AVAILITY +
  "GS*FA*030240928*AV01101957*20030306*1356*1*X*005010X231A1~" +
  "ST*999*0001*005010X231A1~" +
  "AK1*HC*103136*005010X222A1~" +
  "AK2*837*000003136*005010X222A1~" +
  "IK5*A~" +
  "AK9*A*1*1*1~" +
  "SE*6*0001~GE*1*1~IEA*1*000090091~";

describe("parse999", () => {
  it("reads Availity's rejected sample: the TA1, the group, the set and its error", () => {
    const ack = parse999(REJECTED_999);
    expect(ack.ta1).toEqual({ interchangeControlNumber: 1732, status: "A", noteCode: "000" });
    expect(ack.groups).toEqual([
      { functionalId: "HC", groupControlNumber: 17321, version: "005010X223A2", status: "R", included: 1, received: 1, accepted: 0, codes: [] },
    ]);
    expect(ack.sets).toHaveLength(1);
    const set = ack.sets[0]!;
    expect(set).toMatchObject({ groupControlNumber: 17321, type: "837", controlNumber: "000000001", status: "R", codes: ["5"] });
    expect(set.errors).toEqual([
      { segment: "CL1", position: "24", loop: "2300", code: "8", context: ["CLM01:393931D_1310"], elements: [{ position: "2", reference: "1314", code: "5" }] },
    ]);
    expect(setAckState(set.status)).toBe("rejected");
    expect(groupAckState("P")).toBe("partially_accepted");
    expect(describeAckError(set.errors[0]!)).toBe("A claim field is too long (CL1-02, loop 2300)");
  });

  it("says a 999 error as the field a biller knows, and where to fix it", () => {
    const memberId = { segment: "NM1", position: "8", loop: "2010BA", code: "8", elements: [{ position: "9", code: "7" }] };
    expect(describeAckError(memberId)).toBe("The subscriber's member ID has a value that isn't valid (NM1-09, loop 2010BA)");
    expect(ackErrorNextStep(memberId)).toBe(NEXT_STEPS.insurance);
    const dob = { ...memberId, segment: "DMG", elements: [{ position: "2", code: "8" }] };
    expect(describeAckError(dob)).toBe("The subscriber's date of birth has a date that isn't valid (DMG-02, loop 2010BA)");
    expect(ackErrorNextStep(dob)).toBe(NEXT_STEPS.identity);
    const npi = { segment: "NM1", position: "12", loop: "2010AA", code: "8", elements: [{ position: "9", code: "4" }] };
    expect(describeAckError(npi)).toBe("The billing provider's NPI is too short (NM1-09, loop 2010AA)");
    expect(ackErrorNextStep(npi)).toBe(NEXT_STEPS.billing);
    const payerId = { segment: "NM1", position: "20", loop: "2010BB", code: "8", elements: [{ position: "9", code: "7" }] };
    expect(describeAckError(payerId)).toBe("The payer ID has a value that isn't valid (NM1-09, loop 2010BB)");
    expect(ackErrorNextStep(payerId)).toBe(NEXT_STEPS.payerId);
    const units = { segment: "SV1", position: "24", loop: "2400", code: "8", elements: [{ position: "4", code: "1" }, { position: "7", code: "7" }] };
    expect(describeAckError(units)).toBe("A service line's unit count is missing (SV1-04, loop 2400), and 1 more in the same place");
    expect(ackErrorNextStep(units)).toBe(NEXT_STEPS.bill);
    const missing = { segment: "DMG", position: "9", loop: "2010BA", code: "3", elements: [] };
    expect(describeAckError(missing)).toBe("Part of the subscriber details is missing (DMG, loop 2010BA)");
    const envelope = { segment: "NM1", position: "3", loop: "1000A", code: "8", elements: [{ position: "9", code: "7" }] };
    expect(describeAckError(envelope)).toBe("The submitter ID has a value that isn't valid (NM1-09, loop 1000A)");
    expect(ackErrorNextStep(envelope)).toBe(NEXT_STEPS.connection);
  });

  it("says a payer's rejection with the entity put in, the codes, the payer's note and what to do", () => {
    expect(plainStatus({ category: "A7", code: "33", entity: "IL", message: "SUBSCRIBER ID NOT FOUND ON PAYER FILE" })).toBe(
      "Subscriber and subscriber ID not found (A7:33). Payer's note: “SUBSCRIBER ID NOT FOUND ON PAYER FILE”",
    );
    expect(rejectionNextStep({ category: "A7", code: "33", entity: "IL" })).toBe(NEXT_STEPS.insurance);
    expect(plainStatus({ category: "A3", code: "562", entity: "85" })).toBe("The billing provider's National Provider Identifier (NPI) not on file (A3:562)");
    expect(rejectionNextStep({ category: "A3", code: "562", entity: "85" })).toBe(NEXT_STEPS.enrollment);
    expect(rejectionNextStep({ category: "A7", code: "88", entity: "82" })).toBe(NEXT_STEPS.team);
    expect(rejectionNextStep({ category: "A3", code: "686", entity: "" })).toBe(NEXT_STEPS.duplicate);
    expect(rejectionNextStep({ category: "A7", code: "48", entity: "" })).toBe(NEXT_STEPS.bill);
    expect(rejectionNextStep({ category: "A3", code: "999", entity: "" })).toBe(NEXT_STEPS.other);
  });

  it("never keeps IK404, the bad value (it can be a member ID)", () => {
    const ack = parse999(REJECTED_999);
    expect(JSON.stringify(ack)).not.toContain("AA");
  });

  it("reads Availity's accepted sample", () => {
    const ack = parse999(ACCEPTED_999);
    expect(ack.ta1).toBeNull();
    expect(ack.groups[0]).toMatchObject({ groupControlNumber: 103136, status: "A", accepted: 1 });
    expect(ack.sets[0]).toMatchObject({ controlNumber: "000003136", status: "A", errors: [] });
  });

  it("refuses a file that is not a 999", () => {
    expect(() => parse999(ISA_FROM_AVAILITY + "GS*HN*A*B*20260101*0000*1*X*005010X214~ST*277*1*005010X214~SE*2*1~GE*1*1~IEA*1*1~")).toThrow(/not a 999/);
  });
});

const POSITIVE_277CA =
  "ISA*00*          *00*          *01*030240928      *ZZ*AV09311993     *110517*1305*^*00501*000356253*0*T*:~" +
  "GS*HN*030240928*AV01101957*20110517*1305*356254*X*005010X214~" +
  "ST*277*1001*005010X214~BHT*0085*08*356255*20110517*130522*TH~" +
  "HL*1**20*1~NM1*AY*2*AVAILITY LLC*****46*030240928~TRN*1*20110517130522167~DTP*050*D8*20110517~DTP*009*D8*20110517~" +
  "HL*2*1*21*1~NM1*41*2*AVAILITY LLC*****46*030240928~TRN*2*239097104~STC*A1:20*20110517*WQ*259.5~QTY*90*1~AMT*YU*259.5~" +
  "HL*3*2*19*1~NM1*85*2*PROVIDER*****XX*1234567890~TRN*1*0~QTY*QA*1~AMT*YU*259.5~" +
  "HL*4*3*PT~NM1*QC*1*LASTNAME*FIRSTNAME****MI*K11111~TRN*2*TEST00013537401~STC*A1:20*20110517*WQ*259.5~REF*D9*239097104_16~DTP*472*RD8*20100831-20100831~" +
  "SE*25*1001~GE*1*356254~IEA*1*000356253~";

const NEGATIVE_277CA =
  "ISA*00*          *00*          *01*030240928      *ZZ*AV09311993     *110524*1645*^*00501*000448848*0*T*:~" +
  "GS*HN*030240928*AV01101957*20110524*1645*448849*X*005010X214~" +
  "ST*277*1001*005010X214~BHT*0085*08*448850*20110524*164536*TH~" +
  "HL*1**20*1~NM1*AY*2*AVAILITY LLC*****46*030240928~TRN*1*2011052416453672~" +
  "HL*2*1*21*1~NM1*41*2*AVAILITY LLC*****46*030240928~TRN*2*239745576~STC*A1:20*20110524*WQ*75~QTY*AA*1~AMT*YY*75~" +
  "HL*3*2*19*1~NM1*85*2*PROVIDER*****XX*1154374825~TRN*1*0~REF*TJ*561853990~QTY*QC*1~AMT*YY*75~" +
  "HL*4*3*PT~NM1*QC*1*LASTNAME*FIRSTNAME****MI*W1234567890~TRN*2*110549~STC*A3:448*20110524*U*75********TRANSACTION SET HEADER IS INVALID. INVALID DATA 005010X222~REF*D9*239745576_0~DTP*472*RD8*20101001-20101001~" +
  "SE*26*1001~GE*1*448849~IEA*1*000448848~";

describe("parse277 — 277CA", () => {
  it("reads Availity's positive sample: one claim, accepted, with the clearinghouse trace", () => {
    const doc = parse277(POSITIVE_277CA);
    expect(doc.kind).toBe("277ca");
    expect(doc.batchStatuses).toHaveLength(1);
    expect(doc.claims).toHaveLength(1);
    const c = doc.claims[0]!;
    expect(c).toMatchObject({ patientControlNumber: "TEST00013537401", clearinghouseTrace: "239097104_16", serviceFrom: "2010-08-31", serviceTo: "2010-08-31" });
    expect(c.statuses[0]).toMatchObject({ category: "A1", code: "20", action: "WQ", chargeCents: 25950 });
    expect(claimState277(c.statuses)).toBe("accepted");
  });

  it("reads Availity's negative sample: rejected (U), with the payer's message", () => {
    const c = parse277(NEGATIVE_277CA).claims[0]!;
    expect(c.patientControlNumber).toBe("110549");
    expect(c.statuses[0]).toMatchObject({ category: "A3", code: "448", action: "U", message: "TRANSACTION SET HEADER IS INVALID. INVALID DATA 005010X222" });
    expect(isRejection(c.statuses[0]!)).toBe(true);
    expect(claimState277(c.statuses)).toBe("rejected");
    expect(describeStatus(c.statuses[0]!)).toBe(
      "Returned as unprocessable — Transaction set header invalid (448): TRANSACTION SET HEADER IS INVALID. INVALID DATA 005010X222",
    );
  });

  it("knows who is speaking: Availity's own 277CA is the clearinghouse's, not the payer's", () => {
    expect(parse277(POSITIVE_277CA).source).toBe("clearinghouse");
    expect(parse277(NEGATIVE_277CA).source).toBe("clearinghouse");
    const fromPayer = POSITIVE_277CA.replace("NM1*AY*2*AVAILITY LLC*****46*030240928", "NM1*PR*2*MEDICARE OHIO*****PI*15202");
    expect(parse277(fromPayer).source).toBe("payer");
    // CONTROL: the receiver (NM1*41) and the provider (NM1*85) never decide it.
    const noSource = POSITIVE_277CA.replace("NM1*AY*2*AVAILITY LLC*****46*030240928~", "");
    expect(parse277(noSource).source).toBeNull();
  });

  it("says a status once when its code means what its category does (A2:20)", () => {
    expect(describeStatus({ category: "A2", code: "20" })).toBe("Accepted for processing (20)");
    expect(describeStatus({ category: "A1", code: "20" })).toBe("Received — Accepted for processing (20)");
  });

  it("never keeps the patient's name or member ID", () => {
    const json = JSON.stringify(parse277(NEGATIVE_277CA));
    expect(json).not.toContain("LASTNAME");
    expect(json).not.toContain("W1234567890");
  });
});

describe("parse277 — 277 status (005010X212)", () => {
  const STATUS_277 =
    "ISA*00*          *00*          *ZZ*PAYER          *ZZ*AV09311993     *261029*1405*^*00501*000000009*0*P*:~" +
    "GS*HN*PAYER*AV09311993*20261029*1405*9*X*005010X212~ST*277*0001*005010X212~BHT*0010*08*T1*20261029*1405*DG~" +
    "HL*1**20*1~NM1*PR*2*MEDICARE OHIO*****PI*15202~HL*2*1*21*1~NM1*41*2*PALLIO*****46*AV09311993~" +
    "HL*3*2*19*1~NM1*1P*2*DEMO*****XX*1234567893~HL*4*3*22*0~NM1*IL*1*TESTCASE*RUTH****MI*1EG4TE5MK72~" +
    "TRN*2*B2E303AFE2CB~STC*F1:65*20261025**289.53*231.62*20261024**20261025*EFT123~REF*1K*26300123456789~REF*EJ*B2E303AFE2CB~DTP*472*RD8*20261027-20261027~" +
    "SE*16*0001~GE*1*9~IEA*1*000000009~";

  it("reads a finalized, paid status with its payment details", () => {
    const doc = parse277(STATUS_277);
    expect(doc.kind).toBe("277");
    expect(doc.source).toBe("payer");
    const c = doc.claims[0]!;
    expect(c).toMatchObject({ patientControlNumber: "B2E303AFE2CB", payerClaimNumber: "26300123456789", patientAccountNumber: "B2E303AFE2CB" });
    expect(c.statuses[0]).toMatchObject({ category: "F1", code: "65", chargeCents: 28953, paidCents: 23162, adjudicatedDate: "2026-10-24", paymentDate: "2026-10-25", checkNumber: "EFT123" });
    expect(claimState277(c.statuses)).toBe("finalized");
  });

  it("a status question the payer could not answer says nothing about the claim (CONTROL: not a rejection)", () => {
    const st = { category: "E0", code: "0", entity: "", effectiveDate: null, action: "", chargeCents: null, paidCents: null, adjudicatedDate: null, paymentDate: null, checkNumber: "", message: "" };
    expect(isRejection(st)).toBe(false);
    expect(claimState277([st])).toBeNull();
    expect(claimState277([{ ...st, category: "A4" }])).toBeNull();
    expect(claimState277([{ ...st, category: "P1" }])).toBe("pending");
  });
});

const ELIG_271 =
  "ISA*00*          *00*          *ZZ*PAYER          *ZZ*AV09311993     *261029*1405*^*00501*000000010*0*P*:~" +
  "GS*HB*PAYER*AV09311993*20261029*1405*10*X*005010X279A1~ST*271*0001*005010X279A1~BHT*0022*11*R1*20261029*1405~" +
  "HL*1**20*1~NM1*PR*2*MEDICARE OHIO*****PI*15202~HL*2*1*21*1~NM1*1P*2*DEMO PALLIATIVE*****XX*1234567893~" +
  "HL*3*2*22*0~TRN*2*T123*1123456789~NM1*IL*1*TESTCASE*RUTH****MI*1EG4TE5MK72~DMG*D8*19410302*F~DTP*346*D8*20060301~" +
  "EB*1**30^1^98*MB*MEDICARE PART B~" +
  "EB*C*IND*30*MB**23*257~DTP*292*RD8*20260101-20261231~" +
  "EB*A*IND*98*MB**27**0.2~" +
  "EB*X**45~DTP*292*RD8*20261001-20261229~LS*2120~NM1*1P*2*PARTNER HOSPICE (TEST)*****XX*1234567893~LE*2120~" +
  "EB*R**30*HN~LS*2120~NM1*PR*2*BUCKEYE ADVANTAGE (TEST)~LE*2120~" +
  "MSG*CALL FOR PRIOR AUTH~SE*24*0001~GE*1*10~IEA*1*000000010~";

describe("parse271", () => {
  it("reads coverage, the plan, deductible, coinsurance, a hospice election and another payer", () => {
    const s = parse271(ELIG_271);
    expect(s.payerName).toBe("MEDICARE OHIO");
    expect(s.coverage).toBe("active");
    expect(s.planDescription).toBe("MEDICARE PART B");
    expect(s.insuranceType).toBe("MB");
    expect(s.planBegin).toBe("2006-03-01");
    const deductible = s.benefits.find((b) => b.info === "C")!;
    expect(deductible).toMatchObject({ amountCents: 25700, from: "2026-01-01", to: "2026-12-31", timePeriod: "23" });
    const coins = s.benefits.find((b) => b.info === "A")!;
    expect(coins.percent).toBe(20);
    expect(s.hospice).toHaveLength(1);
    expect(s.hospice[0]).toMatchObject({ info: "X", from: "2026-10-01", to: "2026-12-29" });
    expect(s.hospice[0]!.entities[0]).toEqual({ role: "1P", name: "PARTNER HOSPICE (TEST)", npi: "1234567893" });
    expect(s.otherPayers).toEqual([{ name: "BUCKEYE ADVANTAGE (TEST)", insuranceType: "HN" }]);
    expect(verificationResult(s)).toBe("active");
  });

  it("a plan that only lists hospice among the services it covers reports no hospice election", () => {
    // Commercial plans list 45 with the rest of what they cover; that is a
    // benefit, not this patient's election, and the chart must not say hospice.
    const s = parse271(ELIG_271.replace("EB*1**30^1^98*MB*MEDICARE PART B~", "EB*1**30^1^45^98*MB*MEDICARE PART B~").replace(/EB\*X\*\*45~[\s\S]*?LE\*2120~/, ""));
    expect(s.coverage).toBe("active");
    expect(s.benefits.some((b) => b.serviceTypes.includes("45"))).toBe(true);
    expect(s.hospice).toEqual([]);
    expect(hospiceElectionText(parse271(ELIG_271).hospice[0]!)).toBe("from 2026-10-01 to 2026-12-29 (PARTNER HOSPICE (TEST))");
  });

  it("keeps no name, member ID or date of birth", () => {
    const json = JSON.stringify(parse271(ELIG_271));
    expect(json).not.toContain("TESTCASE");
    expect(json).not.toContain("1EG4TE5MK72");
    expect(json).not.toContain("19410302");
  });

  it("an unknown member is not_found; a payer that cannot answer is pending", () => {
    const base =
      "ISA*00*          *00*          *ZZ*PAYER          *ZZ*AV09311993     *261029*1405*^*00501*000000011*0*P*:~" +
      "GS*HB*PAYER*AV09311993*20261029*1405*11*X*005010X279A1~ST*271*0001*005010X279A1~BHT*0022*11*R1*20261029*1405~" +
      "HL*1**20*1~NM1*PR*2*MEDICARE OHIO*****PI*15202~HL*2*1*21*1~NM1*1P*2*DEMO*****XX*1234567893~HL*3*2*22*0~TRN*2*T1*1123456789~NM1*IL*1*X*Y****MI*BAD~";
    const end = "SE*10*0001~GE*1*11~IEA*1*000000011~";
    const notFound = parse271(base + "AAA*N**75*C~" + end);
    expect(notFound.coverage).toBe("unknown");
    expect(notFound.errors).toEqual([{ level: "subscriber", code: "75", followUp: "C" }]);
    expect(verificationResult(notFound)).toBe("not_found");
    expect(verificationResult(parse271(base + "AAA*N**42*R~" + end))).toBe("pending");
  });
});

describe("the 270 and 276 Pallio asks with", () => {
  const env = (fid: "HS" | "HR", version: string) => ({
    senderQualifier: "ZZ", senderId: "AV09311993", receiverQualifier: "01", receiverId: "030240928",
    gsSenderCode: "AV09311993", gsReceiverCode: "030240928", usage: "T" as const, interchangeControlNumber: 5,
    groupControlNumber: 6, functionalId: fid, version, now: new Date("2026-10-29T14:05:00Z"),
  });

  it("a 270 asks about the patient on a day, with a trace the 271 echoes", () => {
    const set = buildEligibility270({
      controlNumber: "0001", reference: "E1", now: new Date("2026-10-29T14:05:00Z"),
      payer: { name: "Medicare Ohio", id: "15202" }, provider: { name: "Demo Palliative", npi: "1234567893" },
      patient: { lastName: "Testcase", firstName: "Ruth", memberId: "1EG4TE5MK72", dob: "1941-03-02", sex: "F" },
      traceNumber: "E1T", traceOriginator: traceOriginator("123456789", "1234567893"), serviceTypes: ["30"], asOf: "2026-10-29",
    });
    const doc = readX12(wrapInterchange(env("HS", "005010X279A1"), [set]));
    const tags = doc.segments.map((s) => s.tag);
    expect(tags).toEqual(["ISA", "GS", "ST", "BHT", "HL", "NM1", "HL", "NM1", "HL", "TRN", "NM1", "DMG", "DTP", "EQ", "SE", "GE", "IEA"]);
    expect(doc.segments.find((s) => s.tag === "TRN")!.elements.slice(1)).toEqual(["1", "E1T", "1123456789"]);
    expect(doc.segments.find((s) => s.tag === "SE")!.elements[1]).toBe(String(set.length));
    expect(traceOriginator(null, "1234567893")).toBe("9123456789");
  });

  it("a 276 asks about one claim by its Claim ref, charge and date", () => {
    const set = buildClaimStatus276({
      controlNumber: "0001", reference: "S1", now: new Date("2026-10-29T14:05:00Z"),
      payer: { name: "Medicare Ohio", id: "15202" }, submitter: { name: "Demo", id: "AV09311993" },
      provider: { name: "Demo Palliative", npi: "1234567893" },
      patient: { lastName: "Testcase", firstName: "Ruth", memberId: "1EG4TE5MK72", dob: "1941-03-02", sex: "F" },
      claim: { traceNumber: "S1T", claimRef: "B2E303AFE2CB", payerClaimNumber: null, totalChargeCents: 28953, dateOfService: "2026-10-27" },
    });
    const doc = readX12(wrapInterchange(env("HR", "005010X212"), [set]));
    const segs = doc.segments.map((s) => s.elements.join("*"));
    expect(segs).toContain("REF*EJ*B2E303AFE2CB");
    expect(segs).toContain("AMT*T3*289.53");
    expect(segs).toContain("DTP*472*RD8*20261027-20261027");
    expect(segs.some((s) => s.startsWith("REF*1K"))).toBe(false);
  });
});

describe("classifyClearinghouseFile", () => {
  it("tells X12 files apart by what they say they are", () => {
    expect(classifyClearinghouseFile("x.999", ACCEPTED_999).kind).toBe("999");
    expect(classifyClearinghouseFile("x.277ibr", POSITIVE_277CA).kind).toBe("277ca");
    expect(classifyClearinghouseFile("x.271", ELIG_271).kind).toBe("271");
    expect(classifyClearinghouseFile("x.TA1", ISA_FROM_AVAILITY + "TA1*000000077*261029*1405*R*025~IEA*0*000090091~").kind).toBe("ta1");
  });

  it("knows Availity's own notices and reports by name, and says why a zip cannot be read", () => {
    expect(classifyClearinghouseFile("pallio-837p-000000077.txt2026102914050000-FAILED", "Invalid file type").kind).toBe("notification");
    expect(classifyClearinghouseFile("IBR-202610291405-001.ibr", "1|2026").kind).toBe("vendor_report");
    expect(classifyClearinghouseFile("ERA.zip", "PK\u0003\u0004").note).toMatch(/uncompressed/);
  });
});
