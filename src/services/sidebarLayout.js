// Stable route keys only. This setting arranges navigation; module/site access
// remains enforced independently by the existing permission middleware.
// Keep in sync with NAV_SECTIONS in sales-dg-frontend/src/lib/navigationModules.js.
export const DEFAULT_SIDEBAR_LAYOUT = [
  { id:'overview', items:['/home','/dashboard','/clients','/members'] },
  { id:'lucky-draw', items:['/draws/new','/draws','/draw-collections','/draws/attendance'] },
  { id:'kyc', items:['/kyc/new','/kyc'] },
  { id:'bookings', items:['/bookings/new','/bookings','/booking-payments'] },
  { id:'studio', items:['/booking-form-studio','/application-form-studio','/agreement-studio','/whatsapp-studio','/whatsapp-marketing'] },
  { id:'site-operations', items:['/plot-status','/website-management'] },
  { id:'draw-setup', items:['/draws/scan','/draws/settings'] },
  { id:'records', items:['/plot-documents','/agreements'] },
  { id:'network', items:['/network','/teams'] },
  { id:'sites', items:['/project-details','/project-details?section=payments'] },
  { id:'administration', items:['/profile','/access','/module-show'] },
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
