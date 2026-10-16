import { config } from '../config.js';

/**
 * Sends a transactional email through Resend (https://resend.com) when RESEND_API_KEY and MAIL_FROM are set.
 * Without them (local development) the message is printed to the server console instead, so flows can be tested.
 */
export async function sendMail({ to, subject, text }) {
  if (!config.resendApiKey || !config.mailFrom) {
    console.log(`[mail] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to, subject, text }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status}): ${await res.text().catch(() => '')}`);
}
