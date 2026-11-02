/**
 * The CAQH CORE real-time channel (0120): a 270 or 276 sent in a CORE
 * envelope over HTTPS, the 271 or 277 back in the same call (Connectivity
 * Rule vC2.2.0, Envelope Standard B: SOAP 1.2 with WS-Security
 * UsernameToken). Availity offers it at https://gateway.availity.com:2021/core
 * (Batch EDI Standard Companion Guide, 2023-04-14, p. 60); Waystar, TriZetto
 * and Inovalon give their endpoint at enrollment.
 *
 * Server only. The password travels inside TLS only (assertPublicUrl refuses
 * plain HTTP outside local development) and is never logged or echoed.
 */
import { randomUUID } from "node:crypto";

import { ValidationError } from "@/lib/api";

import { assertPublicUrl } from "../endpoint-guard";

export type CorePayloadType = "X12_270_Request_005010X279A1" | "X12_276_Request_005010X212";

export interface CoreRequest {
  url: string;
  username: string;
  password: string;
  senderId: string;
  receiverId: string;
  payloadType: CorePayloadType;
  /** The whole X12 interchange (ISA … IEA). */
  payload: string;
  timeoutMs?: number;
}

export interface CoreResponse {
  payloadType: string;
  payloadId: string;
  errorCode: string;
  errorMessage: string;
  /** The X12 answer (271 or 277), "" when the envelope carries an error instead. */
  payload: string;
}

export class CoreError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "CoreError";
  }
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The CORE timestamp: UTC, ISO 8601 to the second. */
export function coreTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildCoreEnvelope(req: Omit<CoreRequest, "url" | "timeoutMs">, payloadId: string, now: Date): string {
  const payload = req.payload.includes("]]>") ? xml(req.payload) : `<![CDATA[${req.payload}]]>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope" xmlns:cor="http://www.caqh.org/SOAP/WSDL/CORERule2.2.0.xsd">',
    "<soapenv:Header>",
    '<wsse:Security soapenv:mustUnderstand="true" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">',
    "<wsse:UsernameToken>",
    `<wsse:Username>${xml(req.username)}</wsse:Username>`,
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${xml(req.password)}</wsse:Password>`,
    "</wsse:UsernameToken>",
    "</wsse:Security>",
    "</soapenv:Header>",
    "<soapenv:Body>",
    "<cor:COREEnvelopeRealTimeRequest>",
    `<PayloadType>${req.payloadType}</PayloadType>`,
    "<ProcessingMode>RealTime</ProcessingMode>",
    `<PayloadID>${payloadId}</PayloadID>`,
    `<TimeStamp>${coreTimestamp(now)}</TimeStamp>`,
    `<SenderID>${xml(req.senderId)}</SenderID>`,
    `<ReceiverID>${xml(req.receiverId)}</ReceiverID>`,
    "<CORERuleVersion>2.2.0</CORERuleVersion>",
    `<Payload>${payload}</Payload>`,
    "</cor:COREEnvelopeRealTimeRequest>",
    "</soapenv:Body>",
    "</soapenv:Envelope>",
  ].join("");
}

/** The text of the first element named `name`, whatever its namespace prefix; CDATA unwrapped. */
export function xmlField(doc: string, name: string): string | null {
  const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${name}>`).exec(doc);
  if (!m) return null;
  const inner = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(inner);
  return cdata ? cdata[1]! : unxml(inner);
}

export function parseCoreResponse(body: string): CoreResponse {
  const fault = xmlField(body, "Fault");
  if (fault !== null) {
    const reason = xmlField(fault, "Text") ?? xmlField(fault, "faultstring") ?? "the endpoint returned a SOAP fault";
    throw new CoreError(`The real-time endpoint refused the request: ${reason.slice(0, 300)}`);
  }
  return {
    payloadType: xmlField(body, "PayloadType") ?? "",
    payloadId: xmlField(body, "PayloadID") ?? "",
    errorCode: xmlField(body, "ErrorCode") ?? "",
    errorMessage: xmlField(body, "ErrorMessage") ?? "",
    payload: xmlField(body, "Payload") ?? "",
  };
}

export async function coreRealTime(req: CoreRequest, now: Date = new Date()): Promise<CoreResponse> {
  const url = await assertPublicUrl(req.url);
  const payloadId = randomUUID();
  const body = buildCoreEnvelope(req, payloadId, now);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": 'application/soap+xml; charset=UTF-8; action="RealTimeTransaction"' },
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
      redirect: "error",
    });
  } catch (err) {
    const timeout = err instanceof Error && /timeout|aborted/i.test(err.name + err.message);
    throw new CoreError(timeout ? `${url.hostname} did not answer in time.` : `${url.hostname} could not be reached.`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new CoreError(`${url.hostname} refused the CORE user or password.`);
  if (!res.ok && !/Envelope/.test(text)) throw new CoreError(`${url.hostname} answered HTTP ${res.status}.`);
  const out = parseCoreResponse(text);
  if (out.errorCode && out.errorCode !== "Success" && !out.payload) {
    throw new CoreError(`${url.hostname} answered ${out.errorCode}${out.errorMessage ? `: ${out.errorMessage.slice(0, 300)}` : ""}.`);
  }
  return out;
}
