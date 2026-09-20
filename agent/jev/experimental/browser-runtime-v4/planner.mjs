import { ProviderError } from '../browser-runtime-v3/providers.mjs';
import { validatePlan } from './workflow.mjs';

export const PLANNER_VERSION = 'readonly-workflow-2';
const stepSchema = { type: 'object', additionalProperties: false,
  properties: { operation: { type: 'string', enum: ['search_and_open', 'open_link'] },
    query: { type: 'string' }, targetText: { type: 'string' }, context: { type: 'string' } },
  required: ['operation', 'query', 'targetText', 'context'] };
const schema = { type: 'object', additionalProperties: false,
  properties: { steps: { type: 'array', minItems: 0, maxItems: 4, items: stepSchema } }, required: ['steps'] };

export async function compileWorkflow({ goal, complete, signal }) {
  if (typeof goal !== 'string' || goal.trim().length < 4 || goal.length > 1500 || /[\x00-\x1f]/.test(goal)) {
    throw new ProviderError('invalid_goal');
  }
  if (typeof complete !== 'function') throw new ProviderError('workflow_planner_required');
  const result = await complete({ purpose: 'plan', signal, schema,
    system: 'Compile the user request into a short ordered browser workflow, at most four steps. '
      + 'Supported operations only: search_and_open fills a search input, waits for results and opens the exact named result; '
      + 'open_link opens an already visible link with the exact requested name. Each destination must expose its requested name as a visible heading. '
      + 'Choose the operation separately for each clause: "search/find X and open it" means search_and_open; "open X" without a request to search means open_link. '
      + 'A later search clause must not turn an earlier open clause into search_and_open. '
      + 'Keep each requested search and its opening together in one search_and_open step; do not split it into individual clicks. '
      + 'For a merchant followed by a product, output the merchant step then the product step. '
      + 'query is the main item title/name only, excluding context words; query must be empty for open_link. '
      + 'targetText preserves the requested name; context preserves explicit region, collection or variant constraints for that step. '
      + 'Steps execute sequentially on the current page. "Within that shop" or "within the shop just opened" means continue on the previous destination; '
      + 'do not duplicate the previous shop name as a new result context. Only put a region/collection/variant in context when that clause explicitly requests it. '
      + 'Never invent URLs, IDs, selectors, page contents, extra destinations or facts. Do not drop any constraint. '
      + 'This prototype only reads pages. If the request needs purchases, cart/account changes, login, forms besides search, sorting/filtering, '
      + 'unknown destination names or unsupported operations, return steps:[] so it stops. '
      + 'Example: Search for "North Shop", then search within it for "Blue Pen" => '
      + '{"steps":[{"operation":"search_and_open","query":"North Shop","targetText":"North Shop","context":""},'
      + '{"operation":"search_and_open","query":"Blue Pen","targetText":"Blue Pen","context":""}]}. '
      + 'Example: Open "North Shop" in the arts district, then search there for "Blue Pen" => '
      + '{"steps":[{"operation":"open_link","query":"","targetText":"North Shop","context":"arts district"},'
      + '{"operation":"search_and_open","query":"Blue Pen","targetText":"Blue Pen","context":""}]}. Return only the schema.',
    input: { request: goal } });
  if (!result || Object.keys(result).length !== 1 || !Array.isArray(result.steps)) throw new ProviderError('invalid_workflow_plan');
  // The provider schema has one common shape. Only the appropriate operation
  // fields are admitted to the executor; model-added keys are never discarded.
  const steps = result.steps.map(step => {
    if (!step || Object.keys(step).sort().join(',') !== 'context,operation,query,targetText'
      || typeof step.query !== 'string' || typeof step.context !== 'string') throw new ProviderError('invalid_workflow_plan');
    if (step.operation === 'open_link') {
      if (step.query !== '') throw new ProviderError('invalid_workflow_plan');
      return { operation: step.operation, targetText: step.targetText, context: step.context };
    }
    return step;
  });
  return validatePlan({ steps });
}
