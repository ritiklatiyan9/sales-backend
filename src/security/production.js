export function validateProductionSecurity(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (Buffer.byteLength(env[key] || '') < 32 || /^(some|change|your-|replace)/i.test(env[key])) throw new Error(`${key} must be an independent random secret of at least 32 bytes`);
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) throw new Error('Access and refresh secrets must be different');
  if (String(env.CORS_ORIGIN || '').split(',').some(origin => origin.trim() === '*')) throw new Error('Production CORS must use explicit frontend origins');
  if (/^(true|\*|0\.0\.0\.0\/0|::\/0)$/i.test(env.TRUST_PROXY || '')) throw new Error('Trust only the known reverse proxy subnet');
  if (env.DB_SSL_REJECT_UNAUTHORIZED === 'false') throw new Error('Production database TLS must verify the server certificate');
  if (env.LOGIN_OTP_ENABLED === 'true' && !['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].every(key => env[key])) throw new Error('Enabled login OTP requires working SMTP configuration');
}
