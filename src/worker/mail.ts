import { mailboxEnabled } from "../shared/domain";
import type { Env } from "./env";

export async function sendEmail(env: Env, message: { to: string; subject: string; text: string }) {
  if (mailboxEnabled(env)) {
    await env.DB.prepare("INSERT INTO dev_mailbox (id, recipient, subject, body, createdAt) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), message.to.toLowerCase(), message.subject, message.text, new Date().toISOString())
      .run();
  }
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) console.error("email delivery failed", response.status);
    return;
  }
  if (env.ENVIRONMENT === "production") console.error("transactional email is not configured");
}
