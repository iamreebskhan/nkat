/**
 * A clearinghouse connection's settings and secrets, as data (0120). Pure and
 * client-safe: the Integrations form validates with the same schema the API
 * route does, so a value the server would refuse is refused as the person
 * types it, in a sentence.
 *
 * Settings are what the files carry (IDs, the submitter's contact) and where
 * they travel (hosts, folders, URLs). Secrets are the passwords, the SSH key
 * and the API client secret: written once, encrypted at rest, never sent back
 * to a browser — a form shows only whether each one is saved.
 */
import { z } from "zod";

import { CLEARINGHOUSE_VENDORS, type ClearinghouseVendor, VENDOR_PROFILES } from "./vendors";

/** ISA05/ISA07 qualifiers seen with these four: mutually defined, D-U-N-S, tax ID. */
export const ID_QUALIFIERS = ["ZZ", "01", "14", "20", "27", "28", "29", "30", "33"] as const;

const HOST = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** An SFTP folder: a relative or absolute path, no "..", no control characters. */
const DIR = /^(?!.*\.\.)[A-Za-z0-9_./ -]{0,200}$/;
/** What ISA06/ISA08/GS02/GS03 can hold: letters, digits, and the space padding. */
const ENVELOPE_ID = /^[A-Za-z0-9 ]{2,15}$/;

const text = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} is at most ${max} characters.`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const SubmitterSchema = z
  .object({
    id: z.string().trim().regex(ENVELOPE_ID, "The submitter ID is 2-15 letters or digits."),
    name: text(60, "The submitter name"),
    contactName: text(60, "The contact name"),
    contactPhone: optionalText(30).refine((v) => v === null || v.replace(/\D/g, "").length === 10, "The contact phone has 10 digits."),
    contactEmail: optionalText(80).refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "The contact email is not an email address."),
  })
  .refine((s) => s.contactPhone || s.contactEmail, {
    message: "The submitter contact needs a phone number or an email (the 837P's PER segment carries one).",
    path: ["contactPhone"],
  });

export const ReceiverSchema = z.object({
  qualifier: z.enum(ID_QUALIFIERS, { errorMap: () => ({ message: "Pick the receiver ID qualifier." }) }),
  id: z.string().trim().regex(ENVELOPE_ID, "The receiver ID (ISA08) is 2-15 letters or digits."),
  gsCode: z.string().trim().regex(ENVELOPE_ID, "The receiver code (GS03) is 2-15 letters or digits."),
  name: text(60, "The receiver name"),
  loop1000BId: z.string().trim().regex(/^[A-Za-z0-9]{2,80}$/, "The receiver ID for loop 1000B is 2-80 letters or digits."),
});

export const SftpSchema = z.object({
  host: z.string().trim().regex(HOST, "The SFTP host is a host name such as files.availity.com."),
  port: z.coerce.number().int().min(1).max(65535),
  username: text(100, "The SFTP user"),
  uploadDir: z.string().trim().regex(DIR, "The upload folder is a folder path without '..'."),
  downloadDirs: z
    .array(z.string().trim().regex(DIR, "A download folder is a folder path without '..'."))
    .min(1, "Name at least one folder the responses arrive in.")
    .max(6),
  fileExtension: z.enum([".txt", ".837", ".x12", ".dat", ".edi"]),
  notificationsInUploadDir: z.boolean(),
});

export const CoreSchema = z.object({
  url: z.string().trim().url("The CORE endpoint is a URL.").max(300),
  username: text(100, "The CORE user"),
  /** CORE SenderID and ReceiverID (they usually match ISA06/ISA08). */
  senderId: z.string().trim().regex(/^[A-Za-z0-9]{2,50}$/, "The CORE sender ID is letters and digits."),
  receiverId: z.string().trim().regex(/^[A-Za-z0-9]{2,50}$/, "The CORE receiver ID is letters and digits."),
});

export const AvailityApiSchema = z.object({
  baseUrl: z.string().trim().url("The API base URL is a URL.").max(300),
  clientId: text(200, "The client ID"),
  scope: z.string().trim().max(100).default("hipaa"),
  /** Demo plans only: Availity answers with a canned scenario (X-Api-Mock-Scenario-ID). */
  mockScenario: optionalText(80),
});

export const ConnectionSettingsSchema = z.object({
  senderQualifier: z.enum(ID_QUALIFIERS),
  submitter: SubmitterSchema,
  receiver: ReceiverSchema,
  sftp: SftpSchema.optional().nullable(),
  core: CoreSchema.optional().nullable(),
  availityApi: AvailityApiSchema.optional().nullable(),
  /** EQ01 for an eligibility check: 30 (plan coverage) unless the practice asks for another. */
  eligibilityServiceType: z.string().trim().regex(/^[0-9A-Z]{1,2}$/).default("30"),
});
export type ConnectionSettings = z.infer<typeof ConnectionSettingsSchema>;

/** Secrets as a form sends them: a string sets, null clears, absent keeps. */
const secret = (max: number) => z.string().min(1).max(max).nullable().optional();
export const ConnectionSecretsPatchSchema = z
  .object({
    sftpPassword: secret(200),
    sftpPrivateKey: secret(10_000).refine((v) => !v || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v), "The SSH key is an OpenSSH or PEM private key."),
    sftpPassphrase: secret(200),
    corePassword: secret(200),
    apiClientSecret: secret(300),
  })
  .strict();
export type ConnectionSecretsPatch = z.infer<typeof ConnectionSecretsPatchSchema>;

export type ConnectionSecrets = {
  sftpPassword?: string;
  sftpPrivateKey?: string;
  sftpPassphrase?: string;
  corePassword?: string;
  apiClientSecret?: string;
};
export const SECRET_KEYS = ["sftpPassword", "sftpPrivateKey", "sftpPassphrase", "corePassword", "apiClientSecret"] as const;

/** The secrets after a patch: set, cleared or kept, key by key. */
export function applySecretsPatch(current: ConnectionSecrets, patch: ConnectionSecretsPatch): ConnectionSecrets {
  const next: ConnectionSecrets = { ...current };
  for (const k of SECRET_KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

export const ConnectionInputSchema = z.object({
  vendor: z.enum(CLEARINGHOUSE_VENDORS),
  label: text(80, "The connection's name"),
  environment: z.enum(["test", "production"]),
  batchChannel: z.enum(["sftp", "manual"]),
  realtimeChannel: z.enum(["none", "core_soap", "availity_api"]),
  isPrimary: z.boolean().default(false),
  settings: ConnectionSettingsSchema,
  secrets: ConnectionSecretsPatchSchema.default({}),
});
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;

/**
 * What the channels chosen need, beyond the schema: SFTP needs its settings
 * and a password or a key; CORE needs its settings and password; Availity's
 * API needs its settings and client secret, and is only Availity's. Returns
 * sentences, empty when the connection can be saved.
 */
export function connectionProblems(input: {
  vendor: ClearinghouseVendor;
  batchChannel: "sftp" | "manual";
  realtimeChannel: "none" | "core_soap" | "availity_api";
  settings: ConnectionSettings;
  secrets: ConnectionSecrets;
}): string[] {
  const out: string[] = [];
  if (input.batchChannel === "sftp") {
    if (!input.settings.sftp) out.push("SFTP needs its host, user and folders.");
    if (!input.secrets.sftpPassword && !input.secrets.sftpPrivateKey) out.push("SFTP needs a password or an SSH key.");
  }
  if (input.realtimeChannel === "core_soap") {
    if (!input.settings.core) out.push("CAQH CORE needs its endpoint, user and IDs.");
    if (!input.secrets.corePassword) out.push("CAQH CORE needs its password.");
  }
  if (input.realtimeChannel === "availity_api") {
    if (input.vendor !== "availity") out.push("Availity's API connects to Availity only.");
    if (!input.settings.availityApi) out.push("Availity's API needs its base URL and client ID.");
    if (!input.secrets.apiClientSecret) out.push("Availity's API needs its client secret.");
  }
  if (!VENDOR_PROFILES[input.vendor].realtime.channels.includes(input.realtimeChannel) && input.realtimeChannel !== "none") {
    out.push(`${VENDOR_PROFILES[input.vendor].name} does not offer that real-time channel.`);
  }
  return out;
}

/** A form's starting settings for a vendor, from its profile. */
export function defaultSettings(vendor: ClearinghouseVendor, environment: "test" | "production"): ConnectionSettings {
  const p = VENDOR_PROFILES[vendor];
  return {
    senderQualifier: (p.senderQualifier.value || "ZZ") as ConnectionSettings["senderQualifier"],
    submitter: { id: "", name: "", contactName: "", contactPhone: null, contactEmail: null },
    receiver: {
      qualifier: (p.receiverQualifier.value || "ZZ") as ConnectionSettings["receiver"]["qualifier"],
      id: p.receiverId.value,
      gsCode: p.gsReceiverCode.value,
      name: p.receiverName.value,
      loop1000BId: p.loop1000BId.value,
    },
    sftp: {
      host: p.sftp.host[environment].value,
      port: p.sftp.port.value,
      username: "",
      uploadDir: p.sftp.uploadDir.value,
      downloadDirs: p.sftp.downloadDirs.value,
      fileExtension: (p.sftp.fileExtension.value || ".txt") as ".txt",
      notificationsInUploadDir: p.sftp.notificationsInUploadDir,
    },
    core: p.realtime.coreUrl[environment].value
      ? { url: p.realtime.coreUrl[environment].value, username: "", senderId: "", receiverId: "" }
      : null,
    availityApi: p.realtime.apiBaseUrl
      ? { baseUrl: p.realtime.apiBaseUrl.value, clientId: "", scope: "hipaa", mockScenario: null }
      : null,
    eligibilityServiceType: "30",
  };
}
