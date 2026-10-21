/**
 * GET/PUT /api/settings/note-template — the org's visit-note template.
 *
 * Mark handed over The Perfect Note with a caveat he repeated twice,
 * unprompted [05:55]: "I developed it over eight years ago. It's not quite
 * current to current technology and current rules, but it'll give you an
 * idea." The shipped set is version 1 of an org's template, and every field
 * in it is theirs to change. Until this route existed, nothing in the product
 * could change any of it.
 *
 * A PUT writes a NEW VERSION rather than editing in place — see
 * saveNoteTemplate. Requires settings.org: this decides what counts as a
 * complete note for every clinician in the org, and therefore what can be
 * signed.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { handleServiceError, ok, parseJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import {
  getNoteTemplateForEditing,
  saveNoteTemplate,
} from "@/lib/features/visits/note.service";

const SectionSchema = z.object({
  sectionKey: z.string().trim().min(1).max(63),
  label: z.string().trim().min(1).max(120),
  helpText: z.string().trim().max(400).nullable().default(null),
  kind: z.enum(["prose", "vitals", "list"]),
  isRequired: z.boolean(),
  notRequiredForVisitTypes: z.array(z.string().trim().max(64)).max(20).default([]),
});

const PutSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sections: z.array(SectionSchema).min(1).max(60),
});

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;
  try {
    return ok(await getNoteTemplateForEditing({ orgId: session.orgId }));
  } catch (err) {
    return handleServiceError(err);
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["settings.org"]);
  if (session instanceof Response) return session;

  const body = await parseJson(req, PutSchema);
  if (body instanceof Response) return body;

  try {
    return ok(
      await saveNoteTemplate({
        orgId: session.orgId,
        userId: session.userId,
        name: body.name,
        sections: body.sections.map((s) => ({
          ...s,
          helpText: s.helpText ?? null,
          notRequiredForVisitTypes: s.notRequiredForVisitTypes ?? [],
        })),
      }),
    );
  } catch (err) {
    return handleServiceError(err);
  }
}
