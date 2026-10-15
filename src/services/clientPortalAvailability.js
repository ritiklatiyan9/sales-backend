// Opt in explicitly when client access is reopened. Existing records are retained.
export const clientPortalEnabled = () => process.env.CLIENT_PORTAL_ENABLED === 'true';

export function requireClientPortalEnabled(_req, res, next) {
  if (!clientPortalEnabled()) return res.status(403).json({
    code: 'CLIENT_PORTAL_DISABLED', message: 'Client login is temporarily disabled. Please contact the office.',
  });
  next();
}
