/**
 * Outgoing email.
 *
 * Sent over SMTP when SMTP_HOST is set. Without it the message is written to
 * the server log instead — enough to click a verification link while the
 * panel is being set up, and never a silent loss.
 */

import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;

function smtp() {
  if (!config.mail.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  }
  return transport;
}

/** Resolves to { delivered: true } once the SMTP server took it, or { delivered: false, logged: true }. */
export async function sendMail({ to, subject, text, html }) {
  const t = smtp();
  if (!t) {
    console.log(`[mail] SMTP_HOST is not set — this email was not sent:\n  To: ${to}\n  Subject: ${subject}\n${text.split('\n').map((l) => `  ${l}`).join('\n')}`);
    return { delivered: false, logged: true };
  }
  await t.sendMail({ from: config.mail.from, to, subject, text, html });
  return { delivered: true };
}

export const mailConfigured = () => Boolean(config.mail.host);
