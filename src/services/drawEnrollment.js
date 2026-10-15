import { workflowError } from './drawWorkflow.js';

/** A stable identity for a named draw, while keeping its printed name readable. */
export function normalizeDrawScheme(value, fallback) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw workflowError('Enter a draw name such as A1 or B5');
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (name.length > 150) throw workflowError('Draw name must be at most 150 characters');
  return { name: name || null, key: name ? `name:${name.toUpperCase()}` : 'default' };
}
