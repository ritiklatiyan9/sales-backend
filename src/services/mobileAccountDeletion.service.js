// Only application credentials and notification records are removed here.
// The client account is shared with the legacy client portal, so deleting it
// revokes that portal's login as well. Customer and accounting records remain.
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const positiveId = value => {
  const str = String(value ?? '');
  return /^[1-9]\d{0,9}$/.test(str) && Number(str) <= 2147483647 ? Number(str) : null;
};

export function createMobileAccountDeletion(db, { secureEnrollmentEnabled = () => false } = {}) {
  return {
    async lookup(memberId) {
      const member = positiveId(memberId);
      if (!member) fail(400, 'Enter a valid member ID.');
      const { rows } = await db.query(`SELECT a.id AS account_id, a.phone, m.id AS member_id, m.full_name
        FROM booking_client_members match
        JOIN booking_client_accounts a ON a.id=match.account_id
        JOIN booking_client_members all_links ON all_links.account_id=a.id
        JOIN members m ON m.id=all_links.member_id
        WHERE match.member_id=$1 ORDER BY m.id`, [member]);
      if (!rows.length) fail(404, 'No app account is linked to this member.');
      return {
        accountId: Number(rows[0].account_id),
        phoneLast4: String(rows[0].phone).slice(-4),
        members: rows.map(row => ({ id:Number(row.member_id), name:row.full_name })),
        sharedClientPortalLogin: true,
      };
    },
    async remove({ accountId, memberId, expectedMemberIds, confirmation }) {
      if (!secureEnrollmentEnabled()) fail(503, 'Account deletion requires secure invitation enrollment.');
      const account = positiveId(accountId), member = positiveId(memberId);
      if (!account || !member || confirmation !== 'DELETE APP ACCOUNT' || !Array.isArray(expectedMemberIds)
          || !expectedMemberIds.length || expectedMemberIds.length > 100
          || expectedMemberIds.some(x => !positiveId(x))) fail(400, 'Review and confirm the linked app account first.');
      const expected = expectedMemberIds.map(positiveId).sort((a,b)=>a-b);
      if (new Set(expected).size !== expected.length || !expected.includes(member)) fail(400, 'Review and confirm the linked app account first.');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Invitation issuance/activation locks members first. Use the same
        // order and lock every reviewed member so no code can race deletion.
        const members = await client.query('SELECT id FROM members WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE', [expected]);
        if (members.rows.length !== expected.length) fail(409, 'Linked members changed. Review the account again.');
        const locked = await client.query('SELECT id FROM booking_client_accounts WHERE id=$1 FOR UPDATE', [account]);
        if (!locked.rows.length) fail(404, 'App account not found.');
        const links = await client.query('SELECT member_id FROM booking_client_members WHERE account_id=$1 ORDER BY member_id', [account]);
        const actual = links.rows.map(row => Number(row.member_id));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(409, 'Linked members changed. Review the account again.');
        // Invalidate all invitations including consumed codes for the associated
        // members, preventing old activation links from surviving deletion.
        await client.query('DELETE FROM booking_client_invitations WHERE member_id=ANY($1::integer[])', [actual]);
        // Most push deliveries cascade via token/device; reminders are directly
        // associated with the account and have no FK, so remove them explicitly.
        await client.query('DELETE FROM booking_mobile_push_events WHERE account_id=$1', [account]);
        await client.query('DELETE FROM booking_client_accounts WHERE id=$1', [account]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      return { ok:true };
    },
  };
}
