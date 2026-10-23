// =============================================================================
// Email Service — Nodemailer Transactional Email
// =============================================================================
// Sends verification codes and password reset codes via SMTP.
// Configured from environment variables (see .env.example).

import nodemailer from "nodemailer";
import { VERIFICATION_CODE_TTL_MS, RESET_CODE_TTL_MS } from "./auth-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTtl(ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60000);
  if (minutes < 1) {
    const seconds = Math.round(ttlMs / 1000);
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Transporter Configuration
// ---------------------------------------------------------------------------

const port = Number(process.env.SMTP_PORT) || 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port,
  secure: port === 465, // true for port 465 (SSL), false for STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
});

const FROM_ADDRESS = process.env.SMTP_FROM || "AI Integration Assessment <noreply@localhost>";

// Community invite for the signup welcome email.
const WELCOME_DISCORD_URL = "https://discord.gg/R7hAMztYU";

// ---------------------------------------------------------------------------
// Email Templates
// ---------------------------------------------------------------------------

/**
 * Send a verification code email.
 *
 * @param to - Recipient email address.
 * @param code - The 6-digit verification code (plaintext, for the email body).
 * @param name - The user's full name (for personalization).
 */
export async function sendVerificationEmail(
  to: string,
  code: string,
  name: string
): Promise<void> {
  const firstName = name.split(" ")[0];
  const expiryText = formatTtl(VERIFICATION_CODE_TTL_MS);

  await transporter.sendMail({
    from: FROM_ADDRESS,
    to,
    subject: "Verify your email address",
    html: `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <h1 style="font-size: 24px; color: #1a1a1a; margin-bottom: 8px;">Verify your email</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.5;">
          Hi ${firstName}, enter the following code to verify your email address:
        </p>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #E8837D;">
            ${code}
          </span>
        </div>
        <p style="color: #888; font-size: 14px; line-height: 1.5;">
          This code expires in ${expiryText}. If you didn't create an account, you can safely ignore this email.
        </p>
      </div>
    `,
    text: `Hi ${firstName}, your verification code is: ${code}. This code expires in ${expiryText}.`,
  });
}

/**
 * Send a password reset email with a 6-digit code.
 *
 * Note: The reset flow no longer emails a link. The user is taken to the
 * reset-code entry step immediately after submitting the forgot-password form,
 * so this email carries the code they need to complete the reset.
 *
 * @param to - Recipient email address.
 * @param code - The 6-digit reset code (plaintext, for the email body).
 * @param name - The user's full name (for personalization).
 */
export async function sendPasswordResetEmail(
  to: string,
  code: string,
  name: string
): Promise<void> {
  const firstName = name.split(" ")[0];
  const expiryText = formatTtl(RESET_CODE_TTL_MS);

  await transporter.sendMail({
    from: FROM_ADDRESS,
    to,
    subject: "Reset your password",
    html: `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <h1 style="font-size: 24px; color: #1a1a1a; margin-bottom: 8px;">Reset your password</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.5;">
          Hi ${firstName}, enter the following code to reset your password:
        </p>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #E8837D;">
            ${code}
          </span>
        </div>
        <p style="color: #888; font-size: 14px; line-height: 1.5;">
          This code expires in ${expiryText} and can only be used once. If you didn't request a password reset,
          you can safely ignore this email.
        </p>
      </div>
    `,
    text: `Hi ${firstName}, your password reset code is: ${code}. This code expires in ${expiryText} and can only be used once.`,
  });
}

/**
 * Send a welcome email to a newly created account.
 *
 * Sent ONLY after the server has confirmed the account was created
 * successfully (the caller awaits), and includes both a plain-text and a
 * styled HTML version. Callers must not let a delivery failure block account
 * creation — wrap this in try/catch.
 *
 * @param to - Recipient email address.
 * @param name - The user's full name (for personalization).
 */
export async function sendWelcomeEmail(
  to: string,
  name: string
): Promise<void> {
  const firstName = name.split(" ")[0];

  await transporter.sendMail({
    from: FROM_ADDRESS,
    to,
    subject: "Welcome to the community — you're in! Join our Discord",
    html: `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
        <h1 style="font-size: 24px; color: #1a1a1a; margin-bottom: 8px;">Welcome, ${firstName}! \u{1F389}</h1>
        <p style="color: #555; font-size: 16px; line-height: 1.5;">
          Your account has been created successfully. You're now part of a community
          of students who build, learn, and help each other every day.
        </p>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
          <a href="${WELCOME_DISCORD_URL}"
             style="display: inline-block; background: #5865F2; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; padding: 12px 28px; border-radius: 8px;">
            Join our Discord community
          </a>
        </div>
        <p style="color: #888; font-size: 14px; line-height: 1.5;">
          Study groups, Q&amp;A channels, announcements, events, and people ready to
          answer your questions — see you there!
        </p>
      </div>
    `,
    text: `Hi ${firstName},

Welcome aboard! Your account has been created successfully.

You're now part of a community of students who build, learn, and help each other every day — and Discord is where it all happens.

Join our Discord community here: ${WELCOME_DISCORD_URL}

Inside you'll find study groups, Q&A channels, announcements, events, and friendly people ready to answer your questions.

See you there!

— The Team`,
  });
}
