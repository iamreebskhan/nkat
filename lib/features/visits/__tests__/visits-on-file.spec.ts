/**
 * What a chart's Visits tab says about how many there are. "0 visits on file"
 * over a colleague's five was found by signing in as a clinician outside the
 * patient's care team.
 */
import { describe, expect, it } from "vitest";

import { visitsOnFile } from "../visits-on-file";

describe("visitsOnFile", () => {
  it("counts what is listed when that is everything", () => {
    expect(visitsOnFile({ listed: 3, total: 3, withheld: 0 })).toBe("3 visits on file");
    expect(visitsOnFile({ listed: 1, total: 1, withheld: 0 })).toBe("1 visit on file");
    expect(visitsOnFile({ listed: 0, total: 0, withheld: 0 })).toBe("0 visits on file");
  });

  it("says the list is a page when the history is longer (audit R34)", () => {
    expect(visitsOnFile({ listed: 200, total: 206, withheld: 0 })).toBe("Latest 200 of 206 visits");
  });

  it("never says none when the visits are a colleague's", () => {
    expect(visitsOnFile({ listed: 0, total: 0, withheld: 5 })).toBe(
      "5 visits on file, by other clinicians. They open for this patient's care team.",
    );
    expect(visitsOnFile({ listed: 0, total: 0, withheld: 1 })).toBe(
      "1 visit on file, by another clinician. It opens for this patient's care team.",
    );
  });

  it("separates the reader's own from the rest", () => {
    expect(visitsOnFile({ listed: 1, total: 1, withheld: 3 })).toBe(
      "4 visits on file. Listed here: your 1. The other 3 open for this patient's care team.",
    );
    expect(visitsOnFile({ listed: 2, total: 2, withheld: 1 })).toBe(
      "3 visits on file. Listed here: your 2. The other opens for this patient's care team.",
    );
  });

  it("still says a page is a page when some are withheld", () => {
    expect(visitsOnFile({ listed: 200, total: 206, withheld: 4 })).toBe(
      "210 visits on file. Listed here: the latest 200 of your 206. The other 4 open for this patient's care team.",
    );
  });
});
