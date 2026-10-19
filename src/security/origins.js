export function allowedOrigins(env = process.env) {
  const configured = String(env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  const production = env.NODE_ENV === 'production';
  return new Set([
    ...configured.filter(value => value !== '*'),
    'https://sales-dg-frontend.vercel.app', 'https://www.dgbooking.com', 'https://dgbooking.com',
    ...(!production ? ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000',
      'http://127.0.0.1:5173', 'http://127.0.0.1:5174', 'http://127.0.0.1:3000'] : []),
  ]);
}
export const originAllowed = (origin, env = process.env) => !origin || allowedOrigins(env).has(origin);
