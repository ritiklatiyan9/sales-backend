// Stable route keys only. This setting arranges navigation; module/site access
// remains enforced independently by the existing permission middleware.
export const DEFAULT_SIDEBAR_LAYOUT = [
  { id:'overview', items:['/home','/dashboard'] },
  { id:'site-operations', items:['/clients','/bookings','/plot-status','/website-management','/booking-payments','/bookings/new'] },
  { id:'kyc', items:['/kyc/new','/kyc'] },
  { id:'records', items:['/members','/plot-documents','/agreements','/agreement-studio'] },
  { id:'network', items:['/network','/teams'] },
  { id:'lucky-draw', items:['/draws/new','/draws','/draws/scan','/application-form-studio','/draws/attendance','/draws/settings'] },
  { id:'sites', items:['/booking-form-studio','/project-details','/project-details?section=payments'] },
  { id:'administration', items:['/profile','/access'] },
];
export const canManageSidebar = user => ['admin','super_admin'].includes(user?.role);
const fail = message => { throw Object.assign(new Error(message), { status:400 }); };

export function validateSidebarLayout(layout) {
  const sectionIds = new Set(DEFAULT_SIDEBAR_LAYOUT.map(section => section.id));
  const paths = new Set(DEFAULT_SIDEBAR_LAYOUT.flatMap(section => section.items));
  if (!Array.isArray(layout) || layout.length !== sectionIds.size) fail('Send every sidebar section. Reload the latest menu and try again.');
  const seen = new Set(), sections = new Set();
  const output = layout.map(section => {
    if (!section || typeof section !== 'object' || Object.keys(section).some(key => !['id','items'].includes(key)) || !sectionIds.has(section.id) || sections.has(section.id)) fail('Sidebar sections must be unique and recognised.');
    sections.add(section.id);
    if (!Array.isArray(section.items) || section.items.length > paths.size) fail('Invalid sidebar items.');
    const items = section.items.map(path => {
      if (typeof path !== 'string' || !paths.has(path) || seen.has(path)) fail('Sidebar items must be unique and recognised.');
      seen.add(path); return path;
    });
    return { id:section.id, items };
  });
  if (seen.size !== paths.size) fail('Keep every menu item in the shared layout. Reload the latest menu and try again.');
  return output;
}
