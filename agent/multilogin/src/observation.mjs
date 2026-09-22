import { createHash } from 'node:crypto';
import { createObservation } from './contract.mjs';

// The PAGE IDENTITY a decision depends on: the document (origin + pathname) and
// the set and order of the controls on it. Deliberately excludes the visible
// text, which keeps changing on a live dynamic page (recommendations, timestamps,
// animations) without the page actually being a different page. A decision is
// acted on only while this identity is unchanged; the control itself is still
// re-resolved by id and signature.
export function pageSignature(observation) {
  const origin = observation?.url?.origin ?? null;
  const pathname = observation?.url?.pathname ?? null;
  const signatures = (observation?.controls ?? []).map(control => control.signature);
  return createHash('sha256').update(JSON.stringify([origin, pathname, signatures])).digest('hex');
}

// The live browser's snapshot becomes the shared observation contract here.
// Control ids are epoch-scoped: "e3" only means anything against the epoch that
// produced it. `sourceIndex`/`sourceKey` are retained so execution can re-resolve
// the same control against a later observation; they are never sent to a model.
export function observationFromSnapshot({ snapshot, platform = 'youtube', ttlMs = 15000, now = Date.now() }) {
  const controls = snapshot.controls.map((control, index) => ({
    id: `e${index}`,
    signature: control.key,
    role: control.role || control.tag,
    name: control.label || control.name || '',
    enabled: control.enabled === true,
    visible: true,
    inputType: control.type || null,
    autocomplete: control.autocomplete || null,
    sourceIndex: index,
    sourceKey: control.key,
  }));
  return createObservation({ url: snapshot.url, text: snapshot.text, controls, ttlMs, now });
}

// The LIVE browser observation path emits the shared contract itself: each
// observed control receives an id scoped to this observation's epoch, so "e3" is
// only meaningful together with snapshot.epoch. The control keeps its handle, so
// execution resolves the same control rather than a selector.
export function attachObservation({ snapshot, ttlMs = 15000, now = Date.now() }) {
  const observation = observationFromSnapshot({ snapshot, ttlMs, now });
  observation.controls.forEach((observed, index) => {
    const source = snapshot.controls[index];
    if (!source) return;
    source.id = observed.id;
    source.epoch = observation.epoch;
  });
  snapshot.observation = observation;
  snapshot.epoch = observation.epoch;
  return observation;
}

// The observation id of a control that a decision was taken on. The snapshot and
// the observation are positionally aligned by observationFromSnapshot above, so
// the mapping is exact rather than key-based (duplicate signatures are legal).
export function controlIdFor({ snapshot, observation, control } = {}) {
  const index = snapshot?.controls?.indexOf(control) ?? -1;
  const observed = observation?.controls?.[index] || null;
  if (!observed) return null;
  return observed.id;
}
