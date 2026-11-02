/**
 * Who may reach the NCCI edits (0122): settings.view reads them, settings.org
 * changes them, and a biller, who cannot open Settings, can still see from a
 * bill whether its claim is being checked.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ asked: [] as string[][] }));

vi.mock("@/lib/auth", () => ({
  requireAuth: async (perms: string[]) => {
    h.asked.push(perms);
    return new Response(null, { status: 403 });
  },
}));
vi.mock("@/lib/features/billing/ncci-load.service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/features/billing/ncci-load.service")>();
  const never = () => {
    throw new Error("a refused request reached the service");
  };
  return { ...real, getNcciStatus: never, ncciInUse: never, startNcciLoad: never, addNcciRows: never, commitNcciLoad: never, removeNcciLoad: never };
});

import { GET as billStatus } from "@/app/api/billing/ncci-status/route";
import { DELETE as remove } from "@/app/api/settings/ncci/loads/[id]/route";
import { POST as commit } from "@/app/api/settings/ncci/loads/[id]/commit/route";
import { POST as rows } from "@/app/api/settings/ncci/loads/[id]/rows/route";
import { POST as start } from "@/app/api/settings/ncci/loads/route";
import { GET as status } from "@/app/api/settings/ncci/route";

const ID = "5b000000-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: ID }) };
const post = () => new NextRequest("http://localhost/x", { method: "POST", body: "{}" });

beforeEach(() => {
  h.asked = [];
});

describe("NCCI routes", () => {
  it.each([
    ["the status page", () => status(), "settings.view"],
    ["starting a load", () => start(post()), "settings.org"],
    ["sending rows", () => rows(post(), ctx), "settings.org"],
    ["putting a load in use", () => commit(post(), ctx), "settings.org"],
    ["stopping a load", () => remove(post(), ctx), "settings.org"],
    ["the line on a bill", () => billStatus(), "billing.superbills.view"],
  ])("%s asks for its permission and stops at a refusal", async (_name, call, perm) => {
    const r = await call();
    expect(r.status).toBe(403);
    expect(h.asked).toEqual([[perm]]);
  });
});
