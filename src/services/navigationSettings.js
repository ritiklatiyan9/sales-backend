// UI preferences live beside module permissions, but never grant CRUD access.
// Keep these destination slugs aligned with the frontend navigation catalog.
const SHORTCUT_DESTINATIONS = [
  'home', 'dashboard', 'clients', 'members', 'draws_new', 'draws', 'draws_attendance',
  'kyc_new', 'kyc', 'bookings_new', 'bookings', 'booking_payments',
  'booking_form_studio', 'application_form_studio', 'agreement_studio',
  'plot_status', 'website_management', 'draws_scan', 'draws_settings',
  'plot_documents', 'agreements', 'network', 'teams',
  'project_details', 'payment_details', 'profile', 'access', 'module_show',
];

export const NAVIGATION_SETTINGS = [
  'booking_mobile_navigation',
  ...SHORTCUT_DESTINATIONS.map(key => `booking_mobile_shortcut_${key}`),
];

// Separate show/hide switches for sidebar destinations that share one module key
// (Lucky Draw: enroll, registrations, booking payments, scan & allot; Bookings:
// list, plot status). Admin-managed like modules — users cannot re-show them.
export const ITEM_VISIBILITY_SETTINGS = ['draws_new', 'draws', 'booking_payments', 'draws_scan', 'bookings', 'plot_status']
  .map(key => `booking_item_${key}`);

export const UI_ONLY_SETTINGS = new Set(['booking_accountancy_button', ...NAVIGATION_SETTINGS]);
