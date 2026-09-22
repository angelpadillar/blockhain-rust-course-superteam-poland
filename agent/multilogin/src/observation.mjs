import { createObservation } from './contract.mjs';

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

// The observation id of a control that a decision was taken on. The snapshot and
// the observation are positionally aligned by observationFromSnapshot above, so
// the mapping is exact rather than key-based (duplicate signatures are legal).
export function controlIdFor({ snapshot, observation, control } = {}) {
  const index = snapshot?.controls?.indexOf(control) ?? -1;
  const observed = observation?.controls?.[index] || null;
  if (!observed) return null;
  return observed.id;
}
