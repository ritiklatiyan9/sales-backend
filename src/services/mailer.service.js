import nodemailer from 'nodemailer';

/**
 * Outbound mail (Nodemailer) — used for the admin login OTP.
 *
 * Configure via env:
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS  (Gmail: smtp.gmail.com + app password)
 *   SMTP_SECURE=true for port 465, otherwise STARTTLS on 587
 *   SMTP_FROM   display sender, defaults to SMTP_USER
 *
 * When SMTP is not configured the transporter is null and callers degrade
 * gracefully (admin login skips the OTP step with a server-side warning) —
 * otherwise adding this feature would lock every admin out before the
 * credentials exist.
 */
const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;

let transporter = null;
if (HOST && USER && PASS) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: process.env.SMTP_SECURE === 'true' || PORT === 465,
    auth: { user: USER, pass: PASS },
  });
  console.log(`[booking-api] Mailer ready (${HOST}:${PORT})`);
} else {
  console.warn('[booking-api] SMTP not configured — admin login OTP is DISABLED until SMTP_HOST/SMTP_USER/SMTP_PASS are set');
}

export const mailerEnabled = () => !!transporter;

/** Send the 6-digit login code. Throws on delivery failure (caller surfaces 502). */
export async function sendLoginOtpEmail({ to, name, otp, minutes }) {
  const brand = '#4c1d95';
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"Defence Garden ERP" <${USER}>`,
    to,
    subject: `${otp} is your Defence Garden sign-in code`,
    text: `Hello ${name || ''}\n\nYour Defence Garden sign-in verification code is: ${otp}\nIt expires in ${minutes} minutes.\n\nIf you did not try to sign in, please change your password immediately.`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
        <h2 style="color:${brand};margin:0 0 4px">Defence Garden</h2>
        <p style="color:#64748b;font-size:12px;margin:0 0 20px">Booking &amp; KYC ERP — sign-in verification</p>
        <p style="color:#0f172a;font-size:14px">Hello ${name || 'Admin'},</p>
        <p style="color:#0f172a;font-size:14px">Use this code to finish signing in:</p>
        <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;text-align:center;padding:16px;margin:16px 0">
          <span style="font-size:32px;letter-spacing:10px;font-weight:bold;color:${brand}">${otp}</span>
        </div>
        <p style="color:#64748b;font-size:12px">The code expires in <b>${minutes} minutes</b> and works only once.</p>
        <p style="color:#94a3b8;font-size:11px;margin-top:20px">Didn't try to sign in? Change your password immediately and inform your administrator.</p>
      </div>`,
  });
}
