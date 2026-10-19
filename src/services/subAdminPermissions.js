// Keep role eligibility separate from the full-admin permission bypass.
export const isFullAdmin = user => ['admin', 'super_admin'].includes(user?.role);
export const isSubAdmin = user => user?.role === 'sub_admin';

export function canManageStaffAccess(actor, target) {
  if (actor?.role === 'super_admin') return true;
  if (actor?.role === 'admin') return !isFullAdmin(target);
  return actor?.role === 'sub_admin' && !['super_admin', 'admin', 'sub_admin'].includes(target?.role);
}
