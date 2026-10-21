/**
 * sql-fake's UPDATE and now(), pinned the way list-members-roster.spec.ts pins
 * the SELECT behaviour it depends on.
 *
 * changeVisitType (lib/features/visits/visit.service.ts) is run against this
 * fake by visit-type-change.spec.ts, and its UPDATE carries the guard that
 * matters most there: `AND status = ANY(...)`, which is what refuses a visit
 * signed between the service's read and its write. So the fake has to apply an
 * UPDATE's WHERE for real and report how many rows it touched, and it has to
 * judge every SET expression against the row as it was BEFORE the statement,
 * as Postgres does. Anything else it does not model it still refuses loudly.
 *
 * `||` and the searched CASE are here for the same reason: listVisits selects
 * `p.first_name || ' ' || p.last_name`, and documentVisit's UPDATE sets the
 * status and the note-template pin through CASE, so both statements can be run
 * rather than assumed.
 *
 * FOR UPDATE because rescheduleVisit locks the row it reads the visit's
 * length from, so that read and its UPDATE can be run as well.
 */
import { describe, expect, it } from "vitest";

import { CannotModel, fakeTx, run, type FakeDb } from "./sql-fake";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

function db(): FakeDb {
  return {
    visit: {
      columns: ["id", "org_id", "status", "visit_type", "is_telehealth", "cpt_codes_assigned", "updated_at"],
      rows: [
        { id: "v1", org_id: ORG, status: "in_progress", visit_type: "a", is_telehealth: false, cpt_codes_assigned: ["99349"], updated_at: null },
        { id: "v2", org_id: ORG, status: "documented", visit_type: "a", is_telehealth: false, cpt_codes_assigned: ["99349"], updated_at: null },
        { id: "v1", org_id: OTHER_ORG, status: "in_progress", visit_type: "a", is_telehealth: false, cpt_codes_assigned: ["99349"], updated_at: null },
      ],
    },
  };
}

describe("sql-fake — UPDATE", () => {
  it("writes only the rows its WHERE matches, and returns how many", () => {
    const d = db();
    const n = run(
      d,
      ["UPDATE visit SET visit_type = ", " WHERE id = ", " AND org_id = ", " AND status = ANY(", ")"],
      ["b", "v1", ORG, ["scheduled", "in_progress"]],
    );
    expect(n).toBe(1);
    expect(d.visit!.rows.map((r) => r.visit_type)).toEqual(["b", "a", "a"]);
  });

  it("CONTROL — a row its status predicate refuses is left alone, and the count says 0", () => {
    const d = db();
    const n = run(
      d,
      ["UPDATE visit SET visit_type = ", " WHERE id = ", " AND status = ANY(", ")"],
      ["b", "v2", ["scheduled", "in_progress"]],
    );
    expect(n).toBe(0);
    expect(d.visit!.rows[1]!.visit_type).toBe("a");
  });

  it("evaluates every SET expression against the row as it was before the statement", () => {
    // Postgres semantics: `a = b, b = a` swaps. A fake that assigned as it went
    // would read the new value back and write the same value twice.
    const d = db();
    run(d, ["UPDATE visit SET visit_type = status, status = visit_type WHERE id = 'v2'"], []);
    expect(d.visit!.rows[1]).toMatchObject({ visit_type: "documented", status: "a" });
  });

  it("runs COALESCE over a bind and the column, as the services write it", () => {
    const d = db();
    run(
      d,
      [
        "UPDATE visit SET is_telehealth = COALESCE(",
        "::boolean, is_telehealth), cpt_codes_assigned = COALESCE(",
        "::text[], cpt_codes_assigned) WHERE id = 'v1' AND org_id = ",
        "::uuid",
      ],
      [null, [], ORG],
    );
    // A NULL bind keeps the column; an empty array is a value, not a NULL.
    expect(d.visit!.rows[0]).toMatchObject({ is_telehealth: false, cpt_codes_assigned: [] });
  });

  it("now() is a timestamp, through $executeRaw's count", async () => {
    const d = db();
    const log: string[] = [];
    const n = await fakeTx(d, log).$executeRaw(
      Object.assign(["UPDATE visit SET updated_at = now() WHERE id = ", " AND org_id = ", ""], {
        raw: [],
      }) as unknown as TemplateStringsArray,
      "v1",
      ORG,
    );
    expect(n).toBe(1);
    expect(d.visit!.rows[0]!.updated_at).toBeInstanceOf(Date);
    expect(log[0]).toMatch(/^UPDATE visit SET updated_at = now\(\)/);
  });

  it("refuses what it does not model instead of guessing", () => {
    // RETURNING, an UPDATE with no WHERE, a column the table does not declare,
    // and an operator written without spaces.
    expect(() => run(db(), ["UPDATE visit SET status = 'x' WHERE id = 'v1' RETURNING id"], [])).toThrow(CannotModel);
    expect(() => run(db(), ["UPDATE visit SET status = 'x'"], [])).toThrow(CannotModel);
    expect(() => run(db(), ["UPDATE visit SET nope = 'x' WHERE id = 'v1'"], [])).toThrow(CannotModel);
    expect(() => run(db(), ["UPDATE visit SET status = 'x' WHERE id='v1'"], [])).toThrow(CannotModel);
  });
});

describe("sql-fake — || and CASE", () => {
  const people = (): FakeDb => ({
    patient: {
      columns: ["id", "first_name", "last_name"],
      rows: [
        { id: "p1", first_name: "Ada", last_name: "Lovelace" },
        { id: "p2", first_name: null, last_name: "Nameless" },
      ],
    },
  });

  it("|| joins text, and a NULL on either side makes the whole NULL", () => {
    const rows = run(
      people(),
      ["SELECT (p.first_name || ' ' || p.last_name) AS name FROM patient p ORDER BY p.id"],
      [],
    );
    expect(rows).toEqual([{ name: "Ada Lovelace" }, { name: null }]);
  });

  it("CASE takes the first arm that is true, else its ELSE, else NULL", () => {
    const d = db();
    run(
      d,
      ["UPDATE visit SET status = CASE WHEN status = 'scheduled' THEN 'in_progress' WHEN status = 'in_progress' THEN 'moved' ELSE status END WHERE org_id = ", ""],
      [ORG],
    );
    expect(d.visit!.rows.map((r) => r.status)).toEqual(["moved", "documented", "in_progress"]);
    run(d, ["UPDATE visit SET visit_type = CASE WHEN status = 'nope' THEN 'x' END WHERE id = 'v2'"], []);
    expect(d.visit!.rows[1]!.visit_type).toBeNull();
  });

  it("evaluates only the branch it takes, so an unmodelled branch fails only when taken", () => {
    const sql = (flag: boolean) =>
      run(
        db(),
        ["UPDATE visit SET visit_type = CASE WHEN ", " THEN (SELECT x.slug FROM elsewhere x LIMIT 1) ELSE visit_type END WHERE id = 'v1'"],
        [flag],
      );
    expect(sql(false)).toBe(2);
    expect(() => sql(true)).toThrow(CannotModel);
  });

  it("refuses the simple CASE form and a CASE inside a CASE", () => {
    expect(() =>
      run(db(), ["UPDATE visit SET visit_type = CASE status WHEN 'a' THEN 'b' END WHERE id = 'v1'"], []),
    ).toThrow(CannotModel);
    expect(() =>
      run(
        db(),
        ["UPDATE visit SET visit_type = CASE WHEN status = 'x' THEN CASE WHEN true THEN 'y' END ELSE 'z' END WHERE id = 'v1'"],
        [],
      ),
    ).toThrow(CannotModel);
  });
});

describe("sql-fake — FOR UPDATE", () => {
  it("reads the same rows with the lock as without it", () => {
    const sql = (lock: string) =>
      run(db(), [`SELECT status FROM visit WHERE id = `, ` AND org_id = `, ` LIMIT 1${lock}`], ["v1", ORG]);
    expect(sql(" FOR UPDATE")).toEqual([{ status: "in_progress" }]);
    expect(sql(" FOR UPDATE")).toEqual(sql(""));
  });

  it("refuses it where Postgres does: GROUP BY, HAVING, an aggregate, a LEFT JOIN", () => {
    const people: FakeDb = { ...db(), patient: { columns: ["id"], rows: [] } };
    for (const sql of [
      "SELECT status FROM visit GROUP BY status FOR UPDATE",
      "SELECT status FROM visit GROUP BY status HAVING count(id) > 0 FOR UPDATE",
      "SELECT count(id) AS n FROM visit FOR UPDATE",
      "SELECT v.status FROM visit v LEFT JOIN patient p ON p.id = v.id FOR UPDATE",
    ]) {
      expect(() => run(people, [sql], [])).toThrow(CannotModel);
    }
  });
});
