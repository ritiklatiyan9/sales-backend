// The Booking sign-in page is the entry point for both Booking and its
// Accountancy copy. Business APIs still require Booking's own switch.
export const canUseBooking = user => Boolean(user) && user.can_login_booking !== false;
export const canUseBookingAccounts = user => user?.can_login_booking_accounts === true;
export const canSignInToBooking = user => canUseBooking(user) || canUseBookingAccounts(user);

// Tokens without an app claim predate separate app access. Their current
// database permissions are still checked on every request.
export const isBookingToken = token => Boolean(token) && !token.realm && !token.aud && !token.client
  && (token.app == null || token.app === 'booking');
