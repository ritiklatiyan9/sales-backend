export async function migrateMobileAccountRecovery(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS booking_client_password_resets (
    account_id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL,
    code_hash CHAR(64) NOT NULL UNIQUE,
    token_version INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    FOREIGN KEY (account_id, member_id)
      REFERENCES booking_client_members(account_id, member_id) ON DELETE CASCADE
  )`);
}
