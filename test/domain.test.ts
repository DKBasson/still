import { describe, expect, it } from "vitest";
import { canAssignRole, canOpenReport, canTransition, effectiveStatus, mailboxEnabled } from "../src/shared/domain";

describe("account transitions", () => {
  it("lets staff approve or reject a pending account", () => {
    expect(canTransition("moderator", "pending", "approved")).toBe(true);
    expect(canTransition("moderator", "pending", "rejected")).toBe(true);
    expect(canTransition("user", "pending", "approved")).toBe(false);
  });

  it("keeps bans administrator-only to reverse", () => {
    expect(canTransition("moderator", "approved", "banned")).toBe(true);
    expect(canTransition("moderator", "banned", "approved")).toBe(false);
    expect(canTransition("admin", "banned", "approved")).toBe(true);
  });

  it("expires a timed suspension", () => {
    expect(effectiveStatus("suspended", "2000-01-01T00:00:00.000Z", Date.parse("2020-01-01T00:00:00.000Z"))).toBe("approved");
    expect(effectiveStatus("suspended", null)).toBe("suspended");
    expect(effectiveStatus("banned", "2000-01-01T00:00:00.000Z")).toBe("banned");
  });

  it("reserves role changes for administrators", () => {
    expect(canAssignRole("admin", "moderator")).toBe(true);
    expect(canAssignRole("moderator", "admin")).toBe(false);
  });

  it("closes reports only from an open state", () => {
    expect(canOpenReport("pending", "under_review")).toBe(true);
    expect(canOpenReport("resolved", "dismissed")).toBe(false);
  });

  it("refuses the development mailbox in production", () => {
    expect(mailboxEnabled({ DEV_MAILBOX: "1", ENVIRONMENT: "production" })).toBe(false);
    expect(mailboxEnabled({ DEV_MAILBOX: "1", ENVIRONMENT: "test" })).toBe(true);
  });
});
