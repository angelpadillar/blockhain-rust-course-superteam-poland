import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const STRESS_SHA = 'b3600b683ec97236866d77e31200fa24ec8c8f3f';
export const PROFILE = Object.freeze({
  first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', address: '12 Example Street',
  city: 'London', zip_code: '12345', phone: '1234567890', date: '2000-01-15', time: '12:30',
  number: '5', text: 'Ada Lovelace', search: 'squash',
});
export const LOCAL_CASES = [
  ['native-form', 'native form', 'dev'], ['aria-control', 'custom controls', 'dev'],
  ['contenteditable', 'rich text', 'dev'], ['late-control', 'dynamic forms', 'dev'],
  ['rerender', 'dynamic rerender', 'dev'], ['shadow', 'Shadow DOM', 'dev'],
  ['nested-shadow', 'nested Shadow DOM', 'dev'], ['iframe', 'iframes', 'dev'],
  ['nested-iframe', 'nested iframes', 'dev'], ['dynamic-iframe', 'dynamic iframe', 'dev'],
  ['cross-origin-iframe', 'cross-origin iframe', 'dev'], ['duplicate-labels', 'duplicate labels', 'dev'],
  ['clickable-div', 'custom controls', 'dev'], ['clickable-span', 'custom controls', 'dev'],
  ['clickable-li', 'custom controls', 'dev'], ['delayed-response', 'network delay', 'dev'],
  ['heldout-frame-form', 'nested iframes', 'heldout'], ['heldout-shadow-form', 'nested Shadow DOM', 'heldout'],
  ['heldout-native-form', 'native form', 'heldout'], ['heldout-delayed-form', 'dynamic forms', 'heldout'],
  ['file-upload', 'file upload', 'dev',
    'Attach the supplied file to the Attachment input and save the draft. Do not delete, publish, or send anything.'],
].map(([id, capability, split, goal]) => ({id: `local/${id}`, name: id, layer: 'local', capability, split,
  goal: goal || 'Set the Display name to Ada Lovelace and save the draft. Do not delete, publish, or send anything.',
  oracle: 'server-record', values: PROFILE}));

const inspectedDev = new Set(['vanilla-form', 'iframe-inception-form', 'iframe-inception-level1',
  'iframe-inception-level2', 'iframe-inception-level3', 'shadow-dom-form']);
// Fixture-health registry — harness/reporting metadata only. A task listed
// here still runs and still counts in the RAW score exactly as shipped; the
// DIAGNOSTIC score may exclude it. Evidence must name the upstream defect.
const FIXTURE_HEALTH = new Map([
  ['ember-form', { status: 'BROKEN_UPSTREAM',
    evidence: 'Own submitForm/updateCountry actions throw TypeError (event undefined) on any submit — verified by manual DOM dispatch; no driver can complete it.' }],
  ['shadow-dom-form', { status: 'BROKEN_UPSTREAM',
    evidence: 'collectFormData queries [slot="input"]:checked but priority radios sit inside a slotted div without their own slot attrs — formData.priority can never be set, so validation cannot pass.' }],
]);
export function stressSplit(id) {
  if (inspectedDev.has(id)) return 'dev';
  return createHash('sha256').update(`browser-bench-split-v1:${id}`).digest()[0] % 4 === 0 ? 'heldout' : 'dev';
}
export function capability(id) {
  if (id.includes('iframe')) return 'nested iframes';
  if (id.includes('shadow')) return 'Shadow DOM';
  if (/rich-text|contenteditable/.test(id)) return 'rich text';
  if (/autocomplete/.test(id)) return 'autocomplete';
  if (/file-upload/.test(id)) return 'file upload';
  if (/dynamic|progressive|conditional|animated/.test(id)) return 'dynamic forms';
  if (/dropdown|multi-select|material|jquery/.test(id)) return 'custom controls';
  return id.includes('form') ? 'framework forms' : 'browser primitives';
}
export async function stressCases(root) {
  const published = JSON.parse(await readFile(join(root, 'InteractionTasks_v8.json'), 'utf8'));
  const byName = new Map(published.map(task => {
    const path = task.confirmed_task.match(/challenges\/([a-z0-9-]+)\.html/);
    return [path?.[1], task];
  }));
  const entries = (await readdir(join(root, 'challenges'))).filter(name => name.endsWith('.html')).sort();
  return entries.map(file => {
    const name = file.slice(0, -5), known = byName.get(name);
    const form = /form|iframe-inception/.test(name);
    return {id: `stress/${name}`, name, layer: 'stress', capability: capability(name), split: stressSplit(name),
      path: `/challenges/${file}`, goal: (known?.confirmed_task || `Complete this public ${name} interface using the supplied fictitious profile. Submit only the local test form.`).replace(/https:\/\/\S+/g, '').trim(),
      oracle: known?.ground_truth === 'dumbledore' || form ? 'secret' : known?.ground_truth === 'successfully' ? 'success-message' : null,
      values: PROFILE, publishedTaskId: known?.task_id || null, fixtureHealth: FIXTURE_HEALTH.get(name) || null};
  });
}
export const PENDING_COVERAGE = ['TanStack Form (no page at pinned revision)', 'standalone Lit/Polymer (no page at pinned revision)',
  'popups', 'tabs', 'download', 'drag/drop', 'infinite scroll', 'browser forward',
  'modal nesting', 'React portal', 'SVG controls', 'icon-only controls', 'password isolation', 'financial authorization',
  'live authenticated tasks', 'official BU V1/V2', 'provider stealth'];
