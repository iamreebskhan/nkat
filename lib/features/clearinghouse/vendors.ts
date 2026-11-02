/**
 * The four clearinghouses Mark named [v1 10:58] and what is publicly known of
 * how to connect to each (0120). Pure and client-safe: the Integrations page
 * shows each default with where it came from, and the service uses the same
 * values.
 *
 * Every default here is only a starting value. A practice's own enrollment
 * packet (the IDs a clearinghouse assigns, the SFTP host and folders it
 * enables) is the authority and is entered on the connection; where nothing
 * public could be confirmed the field starts empty and says so.
 *
 * Sources (researched 29 Oct 2026; links in the research report):
 *   Availity — Batch EDI Standard Companion Guide, updated 2023-04-14 (a
 *     payer-hosted copy): ISA/GS values pp. 53-58, 1000A/1000B p. 59, CAQH
 *     CORE p. 60, SFTP pp. 15-22, response files and their names pp. 64-76.
 *     files.availity.com:22 replaced ftp.availity.com:9922 on 31 Oct 2024
 *     (a vendor's integration guide quoting Availity's notice). REST APIs —
 *     developer.availity.com (Availity API Guide; HIPAA Transaction APIs).
 *   Waystar — 837 Institutional Claims 5010 Companion Guide V1.5, Aug 2021
 *     (Waystar's own). SFTP host from a 2023 support-forum log; /Downloads
 *     from a billing vendor's guide: both to confirm at enrollment.
 *   TriZetto Provider Solutions — practice-management vendors' setup guides
 *     (trading partner ID, Site ID, SFTP enabled by TriZetto support).
 *   Inovalon (ABILITY) — no public connectivity specification; everything
 *     from enrollment.
 */

export const CLEARINGHOUSE_VENDORS = ["availity", "waystar", "trizetto", "inovalon"] as const;
export type ClearinghouseVendor = (typeof CLEARINGHOUSE_VENDORS)[number];

export type RealtimeChannel = "none" | "core_soap" | "availity_api";
export type BatchChannel = "sftp" | "manual";

/** Where a default came from, shown beside it. */
export type DefaultSource = "vendor_guide" | "third_party" | "enrollment";

export interface VendorDefault<T> {
  value: T;
  source: DefaultSource;
  note?: string;
}

export interface VendorProfile {
  vendor: ClearinghouseVendor;
  name: string;
  /** What the vendor calls the ID it gives the practice (ISA06, GS02, 1000A NM109). */
  submitterIdLabel: string;
  submitterIdHint: string;
  senderQualifier: VendorDefault<string>;
  receiverQualifier: VendorDefault<string>;
  receiverId: VendorDefault<string>;
  /** GS03, when it differs from ISA08. */
  gsReceiverCode: VendorDefault<string>;
  /** 1000B NM103/NM109. */
  receiverName: VendorDefault<string>;
  loop1000BId: VendorDefault<string>;
  sftp: {
    host: { production: VendorDefault<string>; test: VendorDefault<string> };
    port: VendorDefault<number>;
    uploadDir: VendorDefault<string>;
    downloadDirs: VendorDefault<string[]>;
    fileExtension: VendorDefault<string>;
    /** Availity drops "-success"/"-FAILED" notices into the upload folder. */
    notificationsInUploadDir: boolean;
    usernameHint: string;
  };
  realtime: {
    channels: RealtimeChannel[];
    coreUrl: { production: VendorDefault<string>; test: VendorDefault<string> };
    apiBaseUrl?: VendorDefault<string>;
  };
  /** What the practice has to ask the vendor for, in order. */
  setupSteps: string[];
}

const ENROLLMENT = (note: string): VendorDefault<string> => ({ value: "", source: "enrollment", note });

export const VENDOR_PROFILES: Record<ClearinghouseVendor, VendorProfile> = {
  availity: {
    vendor: "availity",
    name: "Availity",
    submitterIdLabel: "Availity customer ID",
    submitterIdHint: "The ID Availity assigned your organization (it goes in ISA06, GS02 and loop 1000A).",
    senderQualifier: { value: "ZZ", source: "vendor_guide" },
    receiverQualifier: { value: "01", source: "vendor_guide", note: "01 = D-U-N-S number" },
    receiverId: { value: "030240928", source: "vendor_guide", note: "Availity's D-U-N-S number" },
    gsReceiverCode: { value: "030240928", source: "vendor_guide" },
    receiverName: { value: "AVAILITY", source: "vendor_guide" },
    loop1000BId: { value: "030240928", source: "vendor_guide", note: "Or the payer's name and ID, per Availity's guide" },
    sftp: {
      host: {
        production: { value: "files.availity.com", source: "third_party", note: "Was ftp.availity.com:9922 until 31 Oct 2024" },
        test: { value: "qa-files.availity.com", source: "third_party", note: "Availity's QA environment, for integration testing" },
      },
      port: { value: 22, source: "third_party" },
      uploadDir: { value: "SendFiles", source: "vendor_guide" },
      downloadDirs: { value: ["ReceiveFiles"], source: "vendor_guide" },
      fileExtension: { value: ".txt", source: "vendor_guide", note: "Availity refuses files that are not text" },
      notificationsInUploadDir: true,
      usernameHint: "The FTP mailbox user you create in Availity Essentials (Claims & Payments → FTP and EDI Connection Services).",
    },
    realtime: {
      channels: ["availity_api", "core_soap"],
      coreUrl: {
        production: { value: "https://gateway.availity.com:2021/core", source: "vendor_guide" },
        test: ENROLLMENT("Availity Client Services gives the QA endpoint with the B2B setup"),
      },
      apiBaseUrl: { value: "https://api.availity.com/availity/v1", source: "vendor_guide" },
    },
    setupSteps: [
      "Register the organization at availity.com (someone who can sign the Organization Agreement).",
      "Ask Availity Client Services for integration testing in QA, and create the FTP mailbox in QA (qa-apps.availity.com).",
      "In EDI Reporting Preferences choose X12 for the 999 and the 277CA (.277ibr / .277ebr), so Pallio can read every response; leave ERAs uncompressed.",
      "Enroll for claims and ERAs with each payer that requires it (Availity's payer list says which).",
      "For real-time checks: create an app on developer.availity.com (client ID and secret; Demo first, Standard plan for live data), or ask Client Services for a CAQH CORE B2B setup.",
      "Test here with the QA mailbox (ISA15 = T), then create the production mailbox and switch this connection to production.",
    ],
  },
  waystar: {
    vendor: "waystar",
    name: "Waystar",
    submitterIdLabel: "Waystar Client Account ID",
    submitterIdHint: "The Client Account ID Waystar assigned (the child account's, for a billing service).",
    senderQualifier: { value: "ZZ", source: "vendor_guide" },
    receiverQualifier: { value: "ZZ", source: "vendor_guide" },
    receiverId: { value: "WAYSTAR", source: "vendor_guide", note: "Waystar's guide: \"ZirMed or Waystar\"" },
    gsReceiverCode: { value: "WAYSTAR", source: "vendor_guide" },
    receiverName: { value: "WAYSTAR", source: "vendor_guide" },
    loop1000BId: { value: "WAYSTAR", source: "vendor_guide" },
    sftp: {
      host: {
        production: { value: "sshftp.waystar.com", source: "third_party", note: "From a public support-forum log; confirm with Waystar" },
        test: ENROLLMENT("Waystar decides test files by ISA15 or by your account setting"),
      },
      port: { value: 22, source: "third_party" },
      uploadDir: ENROLLMENT("The claims folder Waystar enables for your account"),
      downloadDirs: { value: ["Downloads"], source: "third_party", note: "Ask Waystar to turn PGP off on this folder" },
      fileExtension: { value: ".txt", source: "third_party" },
      notificationsInUploadDir: false,
      usernameHint: "The FTP user Waystar gives your client account (the submitter is taken from it).",
    },
    realtime: {
      channels: ["core_soap"],
      coreUrl: { production: ENROLLMENT("Waystar's CAQH CORE endpoint, from enrollment"), test: ENROLLMENT("From enrollment") },
    },
    setupSteps: [
      "Sign the Waystar agreement and BAA; ask for SFTP batch connectivity for 837P files.",
      "Ask Waystar to disable PreNote and PGP on the downloads folder, so 999, 277CA and 835 files can be read.",
      "Use Waystar's payer list for each payer's Waystar payer ID (or turn on Payer Name Matching).",
      "For real-time eligibility and claim status, ask for the CAQH CORE endpoint and its credentials.",
    ],
  },
  trizetto: {
    vendor: "trizetto",
    name: "TriZetto Provider Solutions",
    submitterIdLabel: "TriZetto Site ID",
    submitterIdHint: "The four-character Site ID TriZetto assigns (call TriZetto Provider Solutions customer support).",
    senderQualifier: { value: "ZZ", source: "third_party" },
    receiverQualifier: { value: "ZZ", source: "third_party" },
    receiverId: { value: "263923727000000", source: "third_party", note: "From a practice-management vendor's TriZetto guide; confirm at enrollment" },
    gsReceiverCode: { value: "263923727", source: "third_party" },
    receiverName: { value: "TRIZETTO PROVIDER SOLUTIONS", source: "third_party" },
    loop1000BId: { value: "263923727", source: "third_party" },
    sftp: {
      host: { production: ENROLLMENT("TriZetto emails the SFTP details once support enables SFTP"), test: ENROLLMENT("From enrollment") },
      port: { value: 22, source: "third_party" },
      uploadDir: ENROLLMENT("From TriZetto"),
      downloadDirs: { value: [], source: "enrollment", note: "TriZetto puts 835s, 999s and 277CAs in three folders: list all three" },
      fileExtension: { value: ".txt", source: "third_party" },
      notificationsInUploadDir: false,
      usernameHint: "The SFTP user TriZetto emails once SFTP is enabled.",
    },
    realtime: {
      channels: ["core_soap"],
      coreUrl: { production: ENROLLMENT("TriZetto's real-time endpoint, from enrollment"), test: ENROLLMENT("From enrollment") },
    },
    setupSteps: [
      "Enroll with TriZetto Provider Solutions and get the Site ID.",
      "Ask support to enable SFTP (24-48 hours) and to turn on the 999, 277CA and ERA reports.",
      "Set up ERA enrollment with each payer (some take 30 days or more).",
      "For real-time eligibility and claim status, ask for the real-time endpoint and credentials.",
    ],
  },
  inovalon: {
    vendor: "inovalon",
    name: "Inovalon (ABILITY)",
    submitterIdLabel: "Inovalon submitter ID",
    submitterIdHint: "The submitter ID Inovalon assigns at enrollment.",
    senderQualifier: { value: "ZZ", source: "enrollment" },
    receiverQualifier: ENROLLMENT("From Inovalon's companion guide"),
    receiverId: ENROLLMENT("From Inovalon's companion guide"),
    gsReceiverCode: ENROLLMENT("From Inovalon's companion guide"),
    receiverName: { value: "INOVALON", source: "enrollment" },
    loop1000BId: ENROLLMENT("From Inovalon's companion guide"),
    sftp: {
      host: { production: ENROLLMENT("From Inovalon"), test: ENROLLMENT("From Inovalon") },
      port: { value: 22, source: "enrollment" },
      uploadDir: ENROLLMENT("From Inovalon"),
      downloadDirs: { value: [], source: "enrollment" },
      fileExtension: { value: ".txt", source: "enrollment" },
      notificationsInUploadDir: false,
      usernameHint: "The SFTP user Inovalon provides.",
    },
    realtime: {
      channels: ["core_soap"],
      coreUrl: { production: ENROLLMENT("From Inovalon"), test: ENROLLMENT("From Inovalon") },
    },
    setupSteps: [
      "Contact Inovalon (ABILITY) for clearinghouse enrollment and its companion guide; Inovalon publishes no public connectivity specification.",
      "Ask for SFTP batch connectivity, the receiver IDs for ISA08/GS03/1000B, and the folders for 999, 277CA and 835 files.",
      "For real-time eligibility and claim status, ask for the CAQH CORE endpoint and credentials.",
    ],
  },
};

export const DEFAULT_SOURCE_LABELS: Record<DefaultSource, string> = {
  vendor_guide: "from the vendor's own guide",
  third_party: "from a third-party guide — confirm with the vendor",
  enrollment: "from your enrollment",
};

/**
 * SBR09, the claim filing indicator, from the payer's type (payer.payer_type,
 * 0003). A connection's payer mapping can override it per payer: Medicaid
 * managed care is MC to most clearinghouses and HM to some.
 */
export const FILING_INDICATOR_BY_PAYER_TYPE: Record<string, string> = {
  medicare_mac: "MB",
  medicare_advantage_org: "16",
  medicaid_state: "MC",
  medicaid_mco: "MC",
  commercial: "CI",
  tpa: "CI",
  workers_comp: "WC",
  auto_no_fault: "AM",
  tribal: "OF",
  self_insured: "CI",
  other: "ZZ",
};

export const FILING_INDICATORS: Record<string, string> = {
  "11": "Other non-federal program",
  "12": "PPO",
  "13": "Point of service",
  "14": "EPO",
  "15": "Indemnity",
  "16": "HMO Medicare risk (Medicare Advantage)",
  AM: "Automobile medical",
  BL: "Blue Cross / Blue Shield",
  CH: "CHAMPUS (TRICARE)",
  CI: "Commercial",
  HM: "HMO",
  MB: "Medicare Part B",
  MC: "Medicaid",
  OF: "Other federal program",
  VA: "Veterans Affairs",
  WC: "Workers' compensation",
  ZZ: "Mutually defined",
};
