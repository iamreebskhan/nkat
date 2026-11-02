#!/usr/bin/env node
/**
 * A stand-in clearinghouse for local development (0120). NOT FOR PRODUCTION.
 *
 * Lets the whole claim cycle run on one machine before any vendor account
 * exists, through Pallio's real code paths: its SFTP client, its CAQH CORE
 * client and its Availity API client all connect here as they would to
 * Availity. Pallio only reaches 127.0.0.1 when CLEARINGHOUSE_ALLOW_PRIVATE_HOSTS=1
 * and NODE_ENV is not production (lib/features/clearinghouse/endpoint-guard.ts).
 *
 *   SFTP  127.0.0.1:2222   SendFiles/ (upload; "-success"/"-FAILED" notices)
 *                          ReceiveFiles/ (.999, .277ibr, .era back), Availity's layout
 *   HTTP  127.0.0.1:2223   POST /core                  CAQH CORE real-time (270→271, 276→277)
 *                          POST /availity/v1/token     client credentials
 *                          POST /availity/v1/coverages, GET /availity/v1/coverages/:id
 *                          GET  /availity/v1/claim-statuses, GET /availity/v1/claim-statuses/:id
 *
 * Credentials and the host key are generated on first run into the data
 * folder (default: <os temp>/pallio-mock-clearinghouse, or MOCK_CH_DIR), in
 * config.json — read them from there; they are never printed.
 *
 * Deterministic answers, by the member ID on the claim or question:
 *   contains REJ999    the 999 rejects that claim's transaction set (NM1 element error)
 *   contains REJ277    the 277CA rejects it: A7:33 subscriber ID not found (action U)
 *   contains NOPAY     accepted, but no 835 follows
 *   contains DENY      accepted, then denied in the 835 (CARC 50) with the payer's claim number
 *   contains HOSP      the 271 reports a hospice election (service type 45)
 *   contains NOTFOUND  the 271 says the subscriber is not found (AAA 75)
 *   otherwise          999 accepted, Availity's 277CA (A1:20) then the payer's (A2:20,
 *                      with a payer claim number), and an 835 paying 80% (CO-45 10%, PR-2 10%)
 * A file not starting with ISA gets Availity's "-FAILED" notice.
 *
 * Run: node scripts/dev/mock-clearinghouse.mjs   (or the "mock-clearinghouse" launch config)
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { constants as FS, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

const DIR = process.env.MOCK_CH_DIR || join(tmpdir(), "pallio-mock-clearinghouse");
const SFTP_PORT = Number(process.env.MOCK_CH_SFTP_PORT || 2222);
const HTTP_PORT = Number(process.env.MOCK_CH_HTTP_PORT || process.env.PORT || 2223);
const HOME = join(DIR, "mailbox");
mkdirSync(join(HOME, "SendFiles"), { recursive: true });
mkdirSync(join(HOME, "ReceiveFiles"), { recursive: true });

const CONFIG = join(DIR, "config.json");
if (!existsSync(CONFIG)) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  writeFileSync(CONFIG, JSON.stringify({
    sftpUser: "pallio-test",
    sftpPassword: randomBytes(12).toString("base64url"),
    coreUser: "pallio-core",
    corePassword: randomBytes(12).toString("base64url"),
    apiClientId: `mock-${randomBytes(6).toString("hex")}`,
    apiClientSecret: randomBytes(16).toString("base64url"),
    hostKey: privateKey,
  }, null, 2), { mode: 0o600 });
}
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const RECEIVER = "030240928";

// ---------------------------------------------------------------------------
// X12 helpers (written independently of Pallio's own reader and writer, so
// the two cross-check each other).
// ---------------------------------------------------------------------------
const now = () => new Date();
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const hm = (d) => d.toISOString().slice(11, 16).replace(":", "");
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
const money = (cents) => (cents / 100).toFixed(2).replace(/\.?0+$/, "") || "0";
let seq = Number(Date.now() % 100000);
const nextSeq = () => (seq = (seq + 1) % 999999999 || 1);

function readFile837(text) {
  const t = text.replace(/^﻿/, "");
  const el = t[3];
  const term = t[t.indexOf(el, 0) === 3 ? findTerminator(t, el) : 105];
  const segs = t.split(term).map((s) => s.replace(/^[\r\n\s]+/, "")).filter(Boolean).map((s) => s.split(el));
  return { segs, el };
}
function findTerminator(t, el) {
  let n = 0;
  for (let i = 0; i < t.length; i++) if (t[i] === el && ++n === 16) return i + 2;
  return 105;
}

function parse837(text) {
  const { segs } = readFile837(text);
  const isa = segs.find((s) => s[0] === "ISA");
  const gs = segs.find((s) => s[0] === "GS");
  const claims = [];
  let cur = null;
  let lines = null;
  let billingName = "PROVIDER";
  let billingNpi = "";
  for (const s of segs) {
    if (s[0] === "ST") {
      cur = { st02: s[2], lines: [] };
      lines = cur.lines;
      claims.push(cur);
    } else if (cur && s[0] === "NM1") {
      if (s[1] === "85") { billingName = s[3]; billingNpi = s[9]; }
      if (s[1] === "IL") { cur.last = s[3]; cur.first = s[4]; cur.member = s[9]; }
      if (s[1] === "PR") { cur.payerName = s[3]; cur.payerId = s[9]; }
    } else if (cur && s[0] === "CLM") {
      cur.ref = s[1];
      cur.totalCents = Math.round(Number(s[2]) * 100);
    } else if (cur && s[0] === "SV1") {
      const [, code, ...mods] = s[1].split(":");
      lines.push({ code, mods: mods.filter(Boolean), chargeCents: Math.round(Number(s[2]) * 100), units: Number(s[4] || 1) });
    } else if (cur && s[0] === "DTP" && s[1] === "472") {
      cur.dos = s[3];
    } else if (cur && s[0] === "REF" && s[1] === "6R") {
      const l = lines[lines.length - 1];
      if (l) l.ctl = s[2];
    }
  }
  return {
    icn: isa ? isa[13].trim() : "000000000",
    ackRequested: isa ? isa[14] === "1" : false,
    sender: isa ? isa[6].trim() : "",
    gsSender: gs ? gs[2] : "",
    gcn: gs ? gs[6] : "1",
    usage: isa ? isa[15] : "T",
    billingName, billingNpi, claims,
  };
}

function envelope(fid, version, sender, receiver, usage, body, preGs = []) {
  const d = now();
  const icn = String(nextSeq()).padStart(9, "0");
  const gcn = String(nextSeq());
  const isa = ["ISA", "00", pad("", 10), "00", pad("", 10), "01", pad(RECEIVER, 15), "ZZ", pad(receiver, 15), ymd(d).slice(2), hm(d), "^", "00501", icn, "0", usage, ":"].join("*");
  // A TA1 rides between ISA and GS (Availity's sample 999, guide p. 87).
  const segs = [isa, ...preGs, `GS*${fid}*${sender}*${receiver}*${ymd(d)}*${hm(d)}*${gcn}*X*${version}`];
  segs.push(...body);
  segs.push(`GE*1*${gcn}`, `IEA*1*${icn}`);
  return segs.join("~") + "~";
}
const set = (st, rows) => {
  const all = [st, ...rows];
  return [...all, `SE*${all.length + 1}*${st.split("*")[2]}`];
};

function make999(f) {
  const body = [];
  let accepted = 0;
  for (const c of f.claims) {
    body.push(`AK2*837*${c.st02}*005010X222A1`);
    if ((c.member || "").includes("REJ999")) {
      body.push("IK3*NM1*8*2010BA*8", `CTX*CLM01:${c.ref}`, "IK4*9*67*7", "IK5*R*5");
    } else {
      body.push("IK5*A");
      accepted += 1;
    }
  }
  const status = accepted === f.claims.length ? "A" : accepted === 0 ? "R" : "P";
  const st = set("ST*999*0001*005010X231A1", [`AK1*HC*${f.gcn}*005010X222A1`, ...body, `AK9*${status}*${f.claims.length}*${f.claims.length}*${accepted}`]);
  const ta1 = f.ackRequested ? [`TA1*${f.icn}*${ymd(now()).slice(2)}*${hm(now())}*A*000`] : [];
  return envelope("FA", "005010X231A1", RECEIVER, f.gsSender, f.usage, st, ta1);
}

// Stage 1 is Availity's own 277CA (its IBR, NM1*AY); stage 2 is the payer's (NM1*PR).
function make277ca(f, stage) {
  const d = ymd(now());
  const ok = f.claims.filter((c) => !(c.member || "").includes("REJ999"));
  const source = stage === 1
    ? `NM1*AY*2*AVAILITY LLC*****46*${RECEIVER}`
    : `NM1*PR*2*${ok[0]?.payerName || "MOCK PAYER"}*****PI*${ok[0]?.payerId || "MOCKPAYER"}`;
  const rows = [
    `BHT*0085*08*${nextSeq()}*${d}*${hm(now())}*TH`,
    "HL*1**20*1", source, `TRN*1*${d}${nextSeq()}`, `DTP*050*D8*${d}`, `DTP*009*D8*${d}`,
    "HL*2*1*21*1", `NM1*41*2*${f.billingName}*****46*${f.sender}`, `TRN*2*${f.icn}`, `STC*A1:19*${d}*WQ*${money(ok.reduce((s, c) => s + c.totalCents, 0))}`,
    // 2200C's status is required too (005010X214), with no date; pyx12 rejects the file without it.
    "HL*3*2*19*1", `NM1*85*2*${f.billingName}*****XX*${f.billingNpi}`, "TRN*1*0", `STC*A1:19**WQ*${money(ok.reduce((s, c) => s + c.totalCents, 0))}`,
  ];
  let hl = 3;
  for (const c of ok) {
    hl += 1;
    const rej = (c.member || "").includes("REJ277");
    rows.push(`HL*${hl}*3*PT`, `NM1*QC*1*${c.last}*${c.first}****MI*${c.member}`, `TRN*2*${c.ref}`);
    if (stage === 1) rows.push(`STC*A1:20*${d}*WQ*${money(c.totalCents)}`);
    else if (rej) rows.push(`STC*A7:33:IL*${d}*U*${money(c.totalCents)}********SUBSCRIBER ID NOT FOUND ON PAYER FILE`);
    else rows.push(`STC*A2:20*${d}*WQ*${money(c.totalCents)}`, `REF*1K*MCK${f.icn.slice(-6)}${c.st02}`);
    rows.push(`REF*D9*${f.icn}_${c.st02}`, `DTP*472*RD8*${c.dos}-${c.dos}`);
  }
  return envelope("HN", "005010X214", RECEIVER, f.gsSender, f.usage, set("ST*277*0001*005010X214", rows));
}

function make835(f) {
  const pay = f.claims.filter((c) => !/REJ999|REJ277|NOPAY/.test(c.member || ""));
  if (pay.length === 0) return null;
  const d = ymd(now());
  const trace = `MOCKEFT${nextSeq()}`;
  let total = 0;
  const rows = [];
  pay.forEach((c, i) => {
    if ((c.member || "").includes("DENY")) {
      // Denied whole: CARC 50 (not medically necessary) on every line, the
      // payer's claim number on the CLP for a corrected claim to replace.
      rows.push(`LX*${i + 1}`, `CLP*${c.ref}*4*${money(c.totalCents)}*0*0*MB*MCK${f.icn.slice(-6)}${c.st02}*12`,
        `NM1*QC*1*${c.last}*${c.first}****MI*${c.member}`, `DTM*232*${c.dos}`);
      for (const l of c.lines) {
        rows.push(`SVC*HC:${[l.code, ...l.mods].join(":")}*${money(l.chargeCents)}*0**${l.units}`, `DTM*472*${c.dos}`,
          `CAS*CO*50*${money(l.chargeCents)}`, ...(l.ctl ? [`REF*6R*${l.ctl}`] : []));
      }
      return;
    }
    // Per line: 80% paid, 10% contractual (CO-45), the rest the patient's
    // (PR-2); the claim's figures are the sums, so they always balance.
    const lines = c.lines.map((l) => {
      const lp = Math.round(l.chargeCents * 0.8);
      const lco = Math.round(l.chargeCents * 0.1);
      return { ...l, lp, lco, lpr: l.chargeCents - lp - lco };
    });
    const paid = lines.reduce((s, l) => s + l.lp, 0);
    const pr = lines.reduce((s, l) => s + l.lpr, 0);
    total += paid;
    rows.push(`LX*${i + 1}`, `CLP*${c.ref}*1*${money(c.totalCents)}*${money(paid)}*${money(pr)}*MB*MCK${f.icn.slice(-6)}${c.st02}*12`,
      `NM1*QC*1*${c.last}*${c.first}****MI*${c.member}`, `DTM*232*${c.dos}`);
    for (const l of lines) {
      rows.push(`SVC*HC:${[l.code, ...l.mods].join(":")}*${money(l.chargeCents)}*${money(l.lp)}**${l.units}`, `DTM*472*${c.dos}`,
        `CAS*CO*45*${money(l.lco)}`, `CAS*PR*2*${money(l.lpr)}`, ...(l.ctl ? [`REF*6R*${l.ctl}`] : []));
    }
  });
  const payer = pay[0].payerName || "MOCK PAYER";
  const head = [
    `BPR*I*${money(total)}*C*ACH*CCP*01*999999999*DA*123456*1512345678**01*999999999*DA*654321*${d}`,
    // PER*BL, the payer's technical contact, is required in 1000A (005010X221A1).
    `TRN*1*${trace}*1512345678`, `DTM*405*${d}`, `N1*PR*${payer}`, "N3*PO BOX 1", "N4*COLUMBUS*OH*43215", "PER*BL*MOCK PAYER EDI*TE*8005550100",
    `N1*PE*${f.billingName}*XX*${f.billingNpi}`,
  ];
  return envelope("HP", "005010X221A1", "MOCKPAYER", f.gsSender, f.usage, set("ST*835*0001", [...head, ...rows]));
}

function stamp() {
  const d = now().toISOString().replace(/\D/g, "").slice(0, 14);
  return { min: d.slice(0, 12), sec: d.slice(0, 14) };
}

function processUpload(name, buf) {
  const text = buf.toString("utf8");
  const batch = now().toISOString().replace(/\D/g, "").slice(0, 16);
  if (!text.replace(/^﻿/, "").startsWith("ISA")) {
    writeFileSync(join(HOME, "SendFiles", `${name}${batch}-FAILED`), "Invalid file format received - please correct and resubmit");
    return;
  }
  writeFileSync(join(HOME, "SendFiles", `${name}${batch}-success`), "File received");
  const f = parse837(text);
  const t = stamp();
  const at = (ms, fn) => setTimeout(fn, ms);
  at(200, () => writeFileSync(join(HOME, "ReceiveFiles", `${batch}.999`), make999(f)));
  at(1200, () => writeFileSync(join(HOME, "ReceiveFiles", `277-${t.sec}0001.277ibr`), make277ca(f, 1)));
  at(2200, () => writeFileSync(join(HOME, "ReceiveFiles", `277-${t.sec}0002.277ebr`), make277ca(f, 2)));
  at(3200, () => {
    const era = make835(f);
    if (era) writeFileSync(join(HOME, "ReceiveFiles", `ERA-MOCKPAYER-${t.min}-001.era`), era);
  });
  console.log(`[mock-ch] received ${name}: ${f.claims.length} claim(s), ICN ${f.icn}`);
}

// ---------------------------------------------------------------------------
// SFTP server
// ---------------------------------------------------------------------------
const safe = (p) => {
  const rel = normalize(String(p || ".").replace(/^\/+/, "")).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = join(HOME, rel === "." ? "" : rel);
  return full.startsWith(HOME) ? full : HOME;
};
const attrsOf = (st) => ({
  mode: st.isDirectory() ? FS.S_IFDIR | 0o755 : FS.S_IFREG | 0o644,
  uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000),
});

new Server({ hostKeys: [cfg.hostKey] }, (client) => {
  client
    .on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === cfg.sftpUser && ctx.password === cfg.sftpPassword) return ctx.accept();
      ctx.reject(["password"]);
    })
    .on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map();
          let next = 0;
          const handle = (v) => {
            const h = Buffer.alloc(4);
            h.writeUInt32BE(++next);
            handles.set(next, v);
            return h;
          };
          const get = (h) => handles.get(h.readUInt32BE(0));
          sftp
            .on("REALPATH", (id, p) => {
              const rel = "/" + normalize(String(p || ".").replace(/^\/+/, "")).replace(/\\/g, "/").replace(/^\.$/, "");
              sftp.name(id, [{ filename: rel, longname: rel, attrs: {} }]);
            })
            .on("STAT", (id, p) => (existsSync(safe(p)) ? sftp.attrs(id, attrsOf(statSync(safe(p)))) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)))
            .on("LSTAT", (id, p) => (existsSync(safe(p)) ? sftp.attrs(id, attrsOf(statSync(safe(p)))) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)))
            .on("OPENDIR", (id, p) => {
              const full = safe(p);
              if (!existsSync(full) || !statSync(full).isDirectory()) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              sftp.handle(id, handle({ dir: full, done: false }));
            })
            .on("READDIR", (id, h) => {
              const v = get(h);
              if (!v || v.done) return sftp.status(id, STATUS_CODE.EOF);
              v.done = true;
              const names = readdirSync(v.dir).map((n) => {
                const st = statSync(join(v.dir, n));
                return { filename: n, longname: `${st.isDirectory() ? "d" : "-"}rw-r--r-- 1 mock mock ${st.size} ${n}`, attrs: attrsOf(st) };
              });
              if (names.length === 0) return sftp.status(id, STATUS_CODE.EOF);
              sftp.name(id, names);
            })
            .on("OPEN", (id, p, flags) => {
              const full = safe(p);
              if (flags & OPEN_MODE.WRITE) return sftp.handle(id, handle({ write: true, path: full, name: p, chunks: [] }));
              if (!existsSync(full)) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              sftp.handle(id, handle({ read: true, data: readFileSync(full) }));
            })
            .on("FSTAT", (id, h) => {
              const v = get(h);
              if (!v) return sftp.status(id, STATUS_CODE.FAILURE);
              sftp.attrs(id, { mode: FS.S_IFREG | 0o644, uid: 0, gid: 0, size: v.data ? v.data.length : 0, atime: 0, mtime: Math.floor(Date.now() / 1000) });
            })
            .on("READ", (id, h, offset, length) => {
              const v = get(h);
              if (!v || !v.data) return sftp.status(id, STATUS_CODE.FAILURE);
              if (offset >= v.data.length) return sftp.status(id, STATUS_CODE.EOF);
              sftp.data(id, v.data.subarray(Number(offset), Number(offset) + length));
            })
            .on("WRITE", (id, h, offset, data) => {
              const v = get(h);
              if (!v || !v.write) return sftp.status(id, STATUS_CODE.FAILURE);
              v.chunks.push({ offset: Number(offset), data: Buffer.from(data) });
              sftp.status(id, STATUS_CODE.OK);
            })
            .on("CLOSE", (id, h) => {
              const v = get(h);
              handles.delete(h.readUInt32BE(0));
              if (v && v.write) {
                const size = v.chunks.reduce((m, c) => Math.max(m, c.offset + c.data.length), 0);
                const buf = Buffer.alloc(size);
                for (const c of v.chunks) c.data.copy(buf, c.offset);
                writeFileSync(v.path, buf);
                const name = String(v.name).split(/[\\/]/).pop();
                if (v.path.startsWith(join(HOME, "SendFiles"))) setTimeout(() => processUpload(name, buf), 50);
              }
              sftp.status(id, STATUS_CODE.OK);
            })
            .on("SETSTAT", (id) => sftp.status(id, STATUS_CODE.OK))
            .on("FSETSTAT", (id) => sftp.status(id, STATUS_CODE.OK))
            .on("REMOVE", (id) => sftp.status(id, STATUS_CODE.PERMISSION_DENIED))
            .on("RENAME", (id) => sftp.status(id, STATUS_CODE.OP_UNSUPPORTED))
            .on("MKDIR", (id) => sftp.status(id, STATUS_CODE.OP_UNSUPPORTED))
            .on("RMDIR", (id) => sftp.status(id, STATUS_CODE.OP_UNSUPPORTED));
        });
      });
    })
    .on("error", () => {});
}).listen(SFTP_PORT, "127.0.0.1", () => console.log(`[mock-ch] SFTP on 127.0.0.1:${SFTP_PORT} (data: ${DIR})`));

// ---------------------------------------------------------------------------
// HTTP: CAQH CORE real-time and Availity's API
// ---------------------------------------------------------------------------
function x12Of(payload) {
  const { segs } = readFile837(payload);
  return segs;
}

function make271(payload) {
  const segs = x12Of(payload);
  const isa = segs.find((s) => s[0] === "ISA");
  const gs = segs.find((s) => s[0] === "GS");
  const prov = segs.find((s) => s[0] === "NM1" && s[1] === "1P") || [];
  const sub = segs.find((s) => s[0] === "NM1" && s[1] === "IL") || [];
  const trn = segs.find((s) => s[0] === "TRN") || [];
  const payer = segs.find((s) => s[0] === "NM1" && s[1] === "PR") || [];
  const member = sub[9] || "";
  const rows = ["BHT*0022*11*R1*" + ymd(now()) + "*" + hm(now()), "HL*1**20*1", `NM1*PR*2*${payer[3] || "MOCK PAYER"}*****PI*${payer[9] || "0"}`,
    "HL*2*1*21*1", `NM1*1P*2*${prov[3] || "PROVIDER"}*****XX*${prov[9] || ""}`, "HL*3*2*22*0", `TRN*2*${trn[2] || "T"}*9MOCKCLEAR`,
    `NM1*IL*1*${sub[3] || ""}*${sub[4] || ""}****MI*${member}`];
  if (member.includes("NOTFOUND")) rows.push("AAA*N**75*C");
  else {
    rows.push("DTP*346*D8*20060301", "EB*1**30^1^98*MB*MEDICARE PART B", "EB*C*IND*30*MB**23*257", "DTP*292*RD8*20260101-20261231", "EB*A*IND*98*MB**27**0.2");
    if (member.includes("HOSP")) rows.push("EB*X**45", "DTP*292*RD8*20261001-20261229", "LS*2120", "NM1*1P*2*PARTNER HOSPICE (TEST)*****XX*1234567893", "LE*2120");
  }
  return envelope("HB", "005010X279A1", isa ? isa[8].trim() : RECEIVER, gs ? gs[2] : "", isa ? isa[15] : "T", set("ST*271*0001*005010X279A1", rows));
}

function make277(payload) {
  const segs = x12Of(payload);
  const isa = segs.find((s) => s[0] === "ISA");
  const gs = segs.find((s) => s[0] === "GS");
  const sub = segs.find((s) => s[0] === "NM1" && s[1] === "IL") || [];
  const ref = segs.find((s) => s[0] === "REF" && s[1] === "EJ") || [];
  const amt = segs.find((s) => s[0] === "AMT") || [];
  const dtp = segs.find((s) => s[0] === "DTP" && s[1] === "472") || [];
  // The payer's own number for the claim, as the 276 asked with it (from the 277CA); one is made up only when it didn't.
  const pcn = segs.find((s) => s[0] === "REF" && s[1] === "1K") || [];
  const d = ymd(now());
  const total = Math.round(Number(amt[2] || 0) * 100);
  const rows = [`BHT*0010*08*S1*${d}*${hm(now())}*DG`, "HL*1**20*1", "NM1*PR*2*MOCK PAYER*****PI*0", "HL*2*1*21*1", "NM1*41*2*PALLIO*****46*X",
    "HL*3*2*19*1", "NM1*1P*2*PROVIDER*****XX*1234567893", "HL*4*3*22*0", `NM1*IL*1*${sub[3] || ""}*${sub[4] || ""}****MI*${sub[9] || ""}`,
    `TRN*2*${ref[2] || "X"}`, `STC*F1:65*${d}**${money(total)}*${money(Math.round(total * 0.8))}*${d}**${d}*MOCKEFT1`, `REF*1K*${pcn[2] || `MCKSTATUS${(ref[2] || "").slice(-4)}`}`,
    `REF*EJ*${ref[2] || ""}`, `DTP*472*RD8*${dtp[3] || `${d}-${d}`}`];
  return envelope("HN", "005010X212", isa ? isa[8].trim() : RECEIVER, gs ? gs[2] : "", isa ? isa[15] : "T", set("ST*277*0001*005010X212", rows));
}

const field = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  if (!m) return "";
  const v = m[1].trim();
  const c = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(v);
  return c ? c[1] : v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
};

function coreResponse(type, payloadId, code, message, payload) {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope" xmlns:cor="http://www.caqh.org/SOAP/WSDL/CORERule2.2.0.xsd"><soapenv:Body><cor:COREEnvelopeRealTimeResponse><PayloadType>${type}</PayloadType><ProcessingMode>RealTime</ProcessingMode><PayloadID>${payloadId}</PayloadID><TimeStamp>${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</TimeStamp><SenderID>${RECEIVER}</SenderID><ReceiverID>PALLIO</ReceiverID><CORERuleVersion>2.2.0</CORERuleVersion><Payload>${payload ? `<![CDATA[${payload}]]>` : ""}</Payload><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></cor:COREEnvelopeRealTimeResponse></soapenv:Body></soapenv:Envelope>`;
}

const tokens = new Map();
const jobs = new Map();
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function coverageFor(q) {
  const member = q.get("memberId") || "";
  if (member.includes("NOTFOUND")) {
    return { statusCode: "19", status: "Request Error", validationMessages: [{ code: "75", errorMessage: "Subscriber not found" }] };
  }
  return {
    statusCode: "4", status: "Complete", payer: { name: "MOCK PAYER (AVAILITY API)" },
    plans: [{
      status: "Active Coverage", statusCode: "1", groupNumber: "GRP-MOCK", groupName: "MEDICARE", insuranceTypeCode: "MB",
      description: "MEDICARE PART B", coverageStartDate: "2006-03-01",
      benefits: [
        { name: "Deductible", statusCode: "C", serviceTypeCode: "30", amount: "257.00", timePeriodQualifierCode: "23" },
        { name: "Co-Insurance", statusCode: "A", serviceTypeCode: "98", percent: "0.2" },
        ...(member.includes("HOSP") ? [{ name: "Hospice", statusCode: "X", serviceTypeCode: "45", startDate: "2026-10-01", endDate: "2026-12-29" }] : []),
      ],
    }],
  };
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") return json(res, 200, { ok: true, mock: "pallio-mock-clearinghouse" });
    // The stand-in's own test credentials, for the local app's setup form to
    // fill in place (so they are typed by no one and printed nowhere). Only
    // to the local app's origin; this server listens on 127.0.0.1 alone.
    if (req.method === "GET" && url.pathname === "/dev/credentials") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "http://localhost:3000" });
      return res.end(JSON.stringify(Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== "hostKey"))));
    }
    if (url.pathname === "/core") {
      if (req.method !== "POST") return json(res, 405, {});
      const user = field(body, "Username");
      const pass = field(body, "Password");
      const id = field(body, "PayloadID") || "none";
      if (user !== cfg.coreUser || pass !== cfg.corePassword) {
        res.writeHead(401, { "content-type": "application/soap+xml" });
        return res.end(coreResponse("CoreEnvelopeError", id, "UnAuthorized", "Username/Password not valid", ""));
      }
      const type = field(body, "PayloadType");
      const payload = field(body, "Payload");
      res.writeHead(200, { "content-type": "application/soap+xml" });
      if (type === "X12_270_Request_005010X279A1") return res.end(coreResponse("X12_271_Response_005010X279A1", id, "Success", "", make271(payload)));
      if (type === "X12_276_Request_005010X212") return res.end(coreResponse("X12_277_Response_005010X212", id, "Success", "", make277(payload)));
      return res.end(coreResponse("CoreEnvelopeError", id, "PayloadTypeIncorrect", "Not supported", ""));
    }
    if (url.pathname === "/availity/v1/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") !== "client_credentials" || f.get("client_id") !== cfg.apiClientId || f.get("client_secret") !== cfg.apiClientSecret) {
        return json(res, 401, { error: "invalid_client" });
      }
      const token = randomBytes(18).toString("base64url");
      tokens.set(token, Date.now() + 300_000);
      return json(res, 200, { token_type: "bearer", access_token: token, expires_in: 300, scope: f.get("scope") });
    }
    if (url.pathname.startsWith("/availity/v1/")) {
      const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!tokens.has(auth) || tokens.get(auth) < Date.now()) return json(res, 401, { statusCode: 401, userMessage: "Unauthorized" });
      const parts = url.pathname.split("/").filter(Boolean); // availity v1 coverages [id]
      const resource = parts[2];
      const id = parts[3];
      if (id) {
        const job = jobs.get(id);
        if (!job) return json(res, 404, { statusCode: 404 });
        return json(res, 200, { id, ...job });
      }
      if (resource === "coverages" && req.method === "POST") {
        const jid = createHash("sha1").update(body + Date.now()).digest("hex").slice(0, 16);
        jobs.set(jid, coverageFor(new URLSearchParams(body)));
        return json(res, 202, { id: jid, statusCode: "0", status: "In Progress" });
      }
      if (resource === "claim-statuses" && req.method === "GET") {
        const jid = createHash("sha1").update(url.search + Date.now()).digest("hex").slice(0, 16);
        const total = url.searchParams.get("claimAmount") || "0";
        jobs.set(jid, {
          statusCode: "4", status: "Complete",
          claimStatuses: [{
            patientControlNumber: url.searchParams.get("patient.accountNumber") || "",
            claimControlNumber: url.searchParams.get("claimNumber") || "MCKAPI0001",
            statusDetails: [{ category: "Finalized/Payment", categoryCode: "F1", status: "Claim/line has been paid", statusCode: "65", entityCode: "PR",
              effectiveDate: new Date().toISOString().slice(0, 10), claimAmount: total, paymentAmount: (Number(total) * 0.8).toFixed(2),
              finalizedDate: new Date().toISOString().slice(0, 10), remittanceDate: new Date().toISOString().slice(0, 10), checkNumber: "MOCKAPI1" }],
          }],
        });
        return json(res, 202, { id: jid, statusCode: "0", status: "In Progress" });
      }
      return json(res, 404, { statusCode: 404 });
    }
    return json(res, 404, {});
  } catch (err) {
    console.error("[mock-ch]", err);
    return json(res, 500, { error: "mock failure" });
  }
}).listen(HTTP_PORT, "127.0.0.1", () => console.log(`[mock-ch] HTTP on 127.0.0.1:${HTTP_PORT}`));
