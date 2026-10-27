const escapeHtml = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

/** Build only; delivery is controlled by the reset service and existing mailer. */
export function buildBrokerPasswordResetEmail({ to, name, code, minutes = 5, fromAddress }) {
  if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)
      || typeof fromAddress !== 'string' || /[\r\n]/.test(fromAddress)
      || !/^[0-9]{6}$/.test(String(code)) || !Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
    throw new Error('Invalid broker reset email');
  }
  const plainName = String(name || 'Partner').replace(/[\r\n]/g, ' ').slice(0, 150);
  const safeName = escapeHtml(plainName);
  return {
    from: { name: 'My Real Partners', address: fromAddress },
    to,
    subject: 'Reset your My Real Partners password',
    text: `Hello ${plainName},\n\nUse this verification code to reset your My Real Partners app password: ${code}\n\nThe code works once and expires in ${minutes} minutes. Never share this code.\n\nIf you did not request this, ignore this email. Your password remains unchanged.`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f6fb;padding:28px 16px;color:#152444">
      <div style="max-width:440px;margin:auto;background:#fff;border:1px solid #e1e6f0;border-radius:24px;overflow:hidden">
        <div style="padding:26px;background:#152444;color:#e4c68b;font-size:12px;font-weight:bold;letter-spacing:2px">MY REAL PARTNERS</div>
        <div style="padding:28px">
          <h1 style="font-size:25px;font-weight:600;margin:0 0 22px">A fresh start.</h1>
          <p style="font-size:14px">Hello ${safeName},</p>
          <p style="font-size:14px;line-height:1.7">Use this code to reset your broker app password:</p>
          <div style="background:#eef1fb;border:1px solid #dfe5f4;border-radius:16px;text-align:center;padding:22px;margin:22px 0;font-size:32px;font-weight:bold;letter-spacing:9px;color:#284784">${code}</div>
          <p style="font-size:12px;line-height:1.7;color:#68758f">This code works once and expires in <b>${minutes} minutes</b>. Never share it.</p>
          <p style="font-size:12px;line-height:1.7;color:#68758f;margin-top:24px">If you did not request this, ignore this email. Your password remains unchanged.</p>
        </div>
      </div>
    </div>`,
  };
}
