export const ACCOUNT_STATUSES = ["pending", "approved", "rejected", "suspended", "banned"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ROLES = ["user", "moderator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const REPORT_REASONS = ["harassment", "inappropriate", "spam", "copyright", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ["pending", "under_review", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const LIMITS = {
  usernameMin: 3,
  usernameMax: 20,
  passwordMin: 10,
  passwordMax: 128,
  title: 100,
  description: 300,
  bio: 160,
  explanation: 500,
  reason: 500,
  imageBytes: 10 * 1024 * 1024,
  avatarBytes: 2 * 1024 * 1024,
  maxDimension: 16000,
  feedPage: 12,
  removalRetentionDays: 90,
} as const;

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: "Harassment or abuse",
  inappropriate: "Inappropriate content",
  spam: "Spam or impersonation",
  copyright: "Copyright or ownership concern",
  other: "Other",
};

export type StaffAction =
  | "approve"
  | "reject"
  | "suspend"
  | "reinstate"
  | "ban"
  | "set_role"
  | "remove_post"
  | "review_report"
  | "resolve_report"
  | "dismiss_report";

const STAFF = new Set<Role>(["moderator", "admin"]);

export function isStaff(role: Role): boolean {
  return STAFF.has(role);
}

export function isAccountStatus(value: string): value is AccountStatus {
  return (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isReportReason(value: string): value is ReportReason {
  return (REPORT_REASONS as readonly string[]).includes(value);
}

/** Timed suspensions expire into approved. Bans never expire on their own. */
export function effectiveStatus(status: AccountStatus, suspendedUntil: string | null, now = Date.now()): AccountStatus {
  if (status !== "suspended" || !suspendedUntil) return status;
  const until = Date.parse(suspendedUntil);
  if (Number.isNaN(until)) return status;
  return until <= now ? "approved" : "suspended";
}

export function canTransition(actor: Role, from: AccountStatus, to: AccountStatus): boolean {
  if (actor === "user") return false;
  if (from === to) return false;
  if (to === "pending") return false;
  if (from === "banned" && to === "approved") return actor === "admin";
  if (from === "banned") return false;
  if (from === "pending" && (to === "approved" || to === "rejected")) return isStaff(actor);
  if (from === "rejected" && to === "approved") return isStaff(actor);
  if (from === "approved" && (to === "suspended" || to === "banned")) return isStaff(actor);
  if (from === "suspended" && (to === "approved" || to === "banned")) return isStaff(actor);
  if (from === "rejected" && (to === "suspended" || to === "banned")) return isStaff(actor);
  return false;
}

export function canAssignRole(actor: Role, next: Role): boolean {
  return actor === "admin" && isRole(next);
}

export function canOpenReport(from: ReportStatus, to: ReportStatus): boolean {
  if (from === "pending" && (to === "under_review" || to === "resolved" || to === "dismissed")) return true;
  if (from === "under_review" && (to === "resolved" || to === "dismissed")) return true;
  return false;
}

export function cleanText(value: unknown, max: number, options: { allowEmpty: boolean; multiline: boolean }): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) return null;
  if (trimmed.length > max) return null;
  if (hasDisallowedControl(trimmed)) return null;
  if (!options.multiline && /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function hasDisallowedControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) return true;
  }
  return false;
}

export function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

export function mailboxEnabled(env: { DEV_MAILBOX?: string; ENVIRONMENT?: string }): boolean {
  return env.DEV_MAILBOX === "1" && env.ENVIRONMENT !== "production";
}
