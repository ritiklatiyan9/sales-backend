import bcrypt from 'bcrypt';

// Serialize all writes to password credentials sharing a mobile number. Login
// requires exactly one match, so duplicate passwords would lock out both owners.
export async function lockClientPasswordPhone(client, phone) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking-client-password:${phone}`]);
}

export async function passwordUsedByAnotherAccount(client, phone, password, exceptAccountId = null) {
  const { rows } = await client.query(
    'SELECT id,password_hash,password_changed FROM booking_client_accounts WHERE phone=$1 ORDER BY id LIMIT 21',
    [phone],
  );
  // Authentication itself refuses to disambiguate more than 20 accounts.
  if (rows.length > 20 || (exceptAccountId == null && rows.length >= 20)) return true;
  for (const account of rows) {
    if (account.password_changed && account.id !== exceptAccountId && await bcrypt.compare(password, account.password_hash)) return true;
  }
  return false;
}
