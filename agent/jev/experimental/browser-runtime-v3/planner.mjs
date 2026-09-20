import { ProviderError } from './providers.mjs';

const validText = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 200 && !/[\x00-\x1f]/.test(value);
export function validateTask(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(k => !['query', 'targetText', 'context'].includes(k))
    || !validText(value.query) || !validText(value.targetText)
    || (value.context !== undefined && (typeof value.context !== 'string' || value.context.length > 200 || /[\x00-\x1f]/.test(value.context)))) {
    throw new ProviderError('invalid_search_task');
  }
  return { query: value.query.trim(), targetText: value.targetText.trim(), context: (value.context || '').trim() };
}

const schema = { type: 'object', additionalProperties: false,
  properties: { query: { type: 'string' }, targetText: { type: 'string' }, context: { type: 'string' } },
  required: ['query', 'targetText', 'context'] };

export async function planGoal({ goal, complete, signal }) {
  if (typeof goal !== 'string' || goal.length < 4 || goal.length > 1500 || /[\x00-\x08]/.test(goal)) throw new ProviderError('invalid_goal');
  // Narrow literal template for callers who intentionally choose a no-LLM path.
  // Extra instructions/constraints cannot be silently dropped by this parser.
  if (!complete) {
    const match = /^(?:Find|Search for) ["“]([^"”]{1,200})["”] and open (?:it|its details|the result)\.?$/i.exec(goal.trim());
    if (!match) throw new ProviderError('planner_required_for_goal');
    return validateTask({ query: match[1], targetText: match[1], context: '' });
  }
  const result = await complete({ purpose: 'plan', signal, schema,
    system: 'Convert the user request into one search-and-open task. query contains only the main item title or name, without collection, category or context words; '
      + 'targetText is the requested item/article/result identity; context disambiguates the requested section, variant or use. '
      + 'Preserve explicit constraints and the user wording of context instead of inventing a likely UI label. Do not invent a destination URL, ID, browser action or fact. '
      + 'This prototype opens a result for viewing only. For purchase/account changes or tasks that need multiple distinct results, '
      + 'return empty strings so the caller rejects the unsupported task. Output only the specified JSON object.',
    input: { request: goal } });
  return validateTask(result);
}
