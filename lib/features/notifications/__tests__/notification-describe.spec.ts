/**
 * What the bell says (Level-1 doc:57): a sentence and a link per row, built
 * from ids, never from the message text.
 */
import { describe, expect, it } from "vitest";

import { describeNotification } from "../notification.service";

const PATIENT = "44444444-4444-4444-8444-444444444444";
const MESSAGE = "55555555-5555-4555-8555-555555555555";

const names = {
  patients: new Map([[PATIENT, "Ruth Alvarez"]]),
  authors: new Map([[MESSAGE, "Marcus Delgado"]]),
};

describe("describeNotification", () => {
  it("says who mentioned you about which patient, and opens their messages", () => {
    expect(
      describeNotification("patient_thread_mention", { patientId: PATIENT, messageId: MESSAGE }, names),
    ).toEqual({
      title: "Marcus Delgado mentioned you about Ruth Alvarez",
      href: `/patients/${PATIENT}?tab=messages`,
    });
  });

  it("CONTROL: still reads when the names cannot be found, and links nowhere without a patient", () => {
    const blank = { patients: new Map(), authors: new Map() };
    expect(describeNotification("patient_thread_mention", { patientId: PATIENT, messageId: MESSAGE }, blank)).toEqual({
      title: "A colleague mentioned you in a patient's messages",
      href: `/patients/${PATIENT}?tab=messages`,
    });
    expect(describeNotification("patient_thread_mention", { patientId: "not-a-uuid" }, blank).href).toBeNull();
  });

  it("reads a new kind's own title and path, and never a link off the app", () => {
    expect(describeNotification("task_assigned", { title: "New task: call family", href: "/tasks/1" }, names)).toEqual({
      title: "New task: call family",
      href: "/tasks/1",
    });
    expect(describeNotification("task_assigned", { href: "https://evil.example" }, names)).toEqual({
      title: "task assigned",
      href: null,
    });
    expect(describeNotification("x", { href: "//evil.example/p" }, names).href).toBeNull();
  });

  it("an escalation names the measure and the patient, never the reading, and opens the chart (0116)", () => {
    const ALERT = "66666666-6666-4666-8666-666666666666";
    expect(describeNotification("escalation_alert", { patientId: PATIENT, alertId: ALERT, measure: "pain", value: 9 }, names)).toEqual({
      title: "Pain crossed the care plan's limit for Ruth Alvarez",
      href: `/patients/${PATIENT}`,
    });
    expect(describeNotification("escalation_alert", { patientId: PATIENT, measure: "fall" }, names).title).toBe(
      "A fall was recorded for Ruth Alvarez",
    );
    // CONTROL: a measure outside the closed set prints nothing of itself.
    expect(describeNotification("escalation_alert", { patientId: PATIENT, measure: "<b>8</b>" }, names).title).toBe(
      "An escalation criterion was met for Ruth Alvarez",
    );
  });

  it("a task says who gave it and about whom, never its words (0116)", () => {
    const USER = "77777777-7777-4777-8777-777777777777";
    const withUsers = { ...names, users: new Map([[USER, "Helen Okafor"]]) };
    expect(
      describeNotification("care_task_assigned", { taskId: MESSAGE, patientId: PATIENT, byUserId: USER, title: "Call the daughter" }, withUsers),
    ).toEqual({ title: "Helen Okafor gave you a task about Ruth Alvarez", href: `/patients/${PATIENT}?tab=tasks` });
    // An administrative task, and a giver who cannot be named.
    expect(describeNotification("care_task_assigned", { taskId: MESSAGE, patientId: null, byUserId: USER }, names)).toEqual({
      title: "A colleague gave you a task",
      href: "/tasks",
    });
  });
});
