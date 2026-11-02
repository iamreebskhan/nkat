/**
 * USCDI demographics (0128): race and ethnicity by the OMB categories, and the
 * preferred language. Each can be declined, which is an answer and not a blank:
 * a certified record has to tell "asked and declined" from "never asked".
 *
 * Race codes and ethnicity codes are the CDC Race and Ethnicity code set's, the
 * ones C-CDA and FHIR carry; a language is its RFC 5646 tag. Pure.
 */
import { z } from "zod";

export const DECLINED = "declined";

export const RACE_OPTIONS = [
  { code: "1002-5", label: "American Indian or Alaska Native" },
  { code: "2028-9", label: "Asian" },
  { code: "2054-5", label: "Black or African American" },
  { code: "2076-8", label: "Native Hawaiian or Other Pacific Islander" },
  { code: "2106-3", label: "White" },
] as const;

export const ETHNICITY_OPTIONS = [
  { code: "2135-2", label: "Hispanic or Latino" },
  { code: "2186-5", label: "Not Hispanic or Latino" },
] as const;

/** The languages most often asked for; the chart takes any of them, or declined. */
export const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "zh", label: "Chinese" },
  { code: "tl", label: "Tagalog" },
  { code: "vi", label: "Vietnamese" },
  { code: "ar", label: "Arabic" },
  { code: "fr", label: "French" },
  { code: "ko", label: "Korean" },
  { code: "ru", label: "Russian" },
  { code: "ht", label: "Haitian Creole" },
  { code: "pt", label: "Portuguese" },
  { code: "de", label: "German" },
  { code: "pl", label: "Polish" },
  { code: "it", label: "Italian" },
  { code: "hi", label: "Hindi" },
  { code: "ur", label: "Urdu" },
  { code: "ase", label: "American Sign Language" },
] as const;

const RACE_CODES: string[] = RACE_OPTIONS.map((r) => r.code);

/** One or more categories, or declined on its own. */
export const RaceSchema = z
  .array(z.string())
  .max(RACE_OPTIONS.length)
  .refine((xs) => new Set(xs).size === xs.length, "A race can be chosen once.")
  .refine((xs) => xs.every((x) => RACE_CODES.includes(x) || x === DECLINED), "Not one of the race categories.")
  .refine((xs) => !xs.includes(DECLINED) || xs.length === 1, "Declined stands alone.");

const oneOf = (options: readonly { code: string }[], message: string) =>
  z.string().refine((v) => v === DECLINED || options.some((o) => o.code === v), message);

export const EthnicitySchema = oneOf(ETHNICITY_OPTIONS, "Not one of the ethnicity categories.");

export const PreferredLanguageSchema = oneOf(LANGUAGE_OPTIONS, "Not one of the languages offered.");

/** What a chart shows for each: a name, "Declined to answer", or null when never asked. */
export function raceText(codes: readonly string[] | null | undefined): string | null {
  if (!codes || codes.length === 0) return null;
  if (codes.includes(DECLINED)) return "Declined to answer";
  return codes.map((c) => RACE_OPTIONS.find((r) => r.code === c)?.label ?? c).join(", ");
}

export function ethnicityText(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === DECLINED) return "Declined to answer";
  return ETHNICITY_OPTIONS.find((e) => e.code === code)?.label ?? code;
}

export function languageText(code: string | null | undefined): string | null {
  if (!code) return null;
  if (code === DECLINED) return "Declined to answer";
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code;
}
