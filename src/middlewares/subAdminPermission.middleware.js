import { hasPermission } from '../services/permissions.service.js';

/** Existing role/site/ownership checks still run in the controller. */
export function subAdminPermission(modules, action) {
  const alternatives = Array.isArray(modules) ? modules : [modules];
  return async (req, res, next) => {
    if (req.user?.role !== 'sub_admin') return next();
    const flag = action || ({ GET:'can_read', HEAD:'can_read', POST:'can_write', PUT:'can_update', PATCH:'can_update', DELETE:'can_delete' }[req.method]);
    if (!flag) return res.status(403).json({ message: 'This action is not permitted.', code:'MODULE_ACCESS_DENIED' });
    try {
      for (const module of alternatives) {
        if (await hasPermission(req.user, module, 'can_read') && (flag === 'can_read' || await hasPermission(req.user, module, flag))) return next();
      }
      res.status(403).json({ message:'Access Control has not granted this action for your account.', code:'MODULE_ACCESS_DENIED' });
    } catch (error) { next(error); }
  };
}
