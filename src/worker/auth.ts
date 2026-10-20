import { betterAuth, APIError } from "better-auth";
import { username } from "better-auth/plugins";
import { LIMITS, effectiveStatus, isAccountStatus } from "../shared/domain";
import type { Env } from "./env";
import { sendEmail } from "./mail";

export function createAuth(env: Env) {
  const secure = env.ENVIRONMENT === "production";
  return betterAuth({
    appName: "still",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN],
    database: env.DB,
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: LIMITS.passwordMin,
      maxPasswordLength: LIMITS.passwordMax,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          subject: "Reset your still password",
          text: `Reset your password by opening this link:\n${url}\n\nIf you did not ask for this, you can ignore the email.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(env, {
          to: user.email,
          subject: "Verify your email for still",
          text: `Confirm this email address by opening the link:\n${url}\n\nYour account still needs an editor's approval before you can sign in to the photographs.`,
        });
      },
    },
    user: {
      additionalFields: {
        accountStatus: { type: "string", required: true, defaultValue: "pending", input: false },
        role: { type: "string", required: true, defaultValue: "user", input: false },
        bio: { type: "string", required: false, defaultValue: "", input: false },
        avatarKey: { type: "string", required: false, input: false },
        statusReason: { type: "string", required: false, input: false },
        suspendedUntil: { type: "string", required: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/sign-up/email": { window: 60 * 60, max: 5 },
        "/sign-in/email": { window: 15 * 60, max: 10 },
        "/request-password-reset": { window: 60 * 60, max: 5 },
        "/send-verification-email": { window: 60 * 60, max: 5 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: secure,
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure, path: "/" },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              accountStatus: "pending",
              role: "user",
              bio: "",
              avatarKey: null,
              statusReason: null,
              suspendedUntil: null,
            },
          }),
        },
        update: {
          before: async (user) => {
            const data = { ...user };
            delete data.accountStatus;
            delete data.role;
            delete data.bio;
            delete data.avatarKey;
            delete data.statusReason;
            delete data.suspendedUntil;
            delete data.emailVerified;
            return { data };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const row = await env.DB.prepare("SELECT accountStatus, suspendedUntil FROM \"user\" WHERE id = ?")
              .bind(session.userId)
              .first<{ accountStatus: string; suspendedUntil: string | null }>();
            if (!row || !isAccountStatus(row.accountStatus)) return false;
            const status = effectiveStatus(row.accountStatus, row.suspendedUntil);
            if (status === "suspended") {
              throw new APIError("FORBIDDEN", { message: "This account is suspended.", code: "account_suspended" });
            }
            if (status === "banned") {
              throw new APIError("FORBIDDEN", { message: "This account is banned.", code: "account_banned" });
            }
            if (status === "approved" && row.accountStatus === "suspended") {
              const now = new Date().toISOString();
              await env.DB.prepare(
                "UPDATE \"user\" SET accountStatus = 'approved', suspendedUntil = NULL, statusReason = NULL, updatedAt = ? WHERE id = ? AND accountStatus = 'suspended'",
              )
                .bind(now, session.userId)
                .run();
            }
            return { data: session };
          },
        },
      },
    },
    plugins: [
      username({
        minUsernameLength: LIMITS.usernameMin,
        maxUsernameLength: LIMITS.usernameMax,
        displayUsername: false,
        immutableUsername: true,
        validationOrder: { username: "post-normalization" },
        usernameValidator: (value) => /^[a-z0-9_]+$/.test(value),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
