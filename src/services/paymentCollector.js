import { resolveClientReferral } from './clientRegistry.service.js';

// Resolve on the server as well as in the picker: never trust a typed name.
// Older payment clients may omit the new field and retain their existing flow.
export async function resolvePaymentCollector(body, siteId, db) {
  if (body.received_by_agent_code === undefined) return null;
  const agent = await resolveClientReferral(body.received_by_agent_code, siteId, db);
  if (!agent) {
    const error = new Error('Enter the agent code of the payment collector');
    error.status = 400;
    throw error;
  }
  return { id: agent.id, ...(agent.member_id ? {memberId:agent.member_id} : {}), name: agent.name, code: agent.referral_code, receivedBy: `${agent.name} (${agent.referral_code})` };
}
