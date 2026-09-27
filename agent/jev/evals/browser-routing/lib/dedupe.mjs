/**
 * Near-duplicate control.
 *
 * Visual frames use 64-bit dHash (Hamming distance <= 4 clusters near-identical
 * frames within the same state family). Text-only decisions use a state
 * fingerprint over page class + normalized element/text signature. Exact image
 * SHA-256 always clusters.
 *
 * Every duplicate keeps a pointer to its representative; representatives are
 * chosen by label quality, then verification strength, then earliest capture.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { LABEL_QUALITY } from './schema.mjs';

const LABEL_RANK = new Map(LABEL_QUALITY.map((label, index) => [label, index]));

export function imageMagickAvailable() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** dHash via ImageMagick: 9x8 grayscale, horizontal neighbour comparison. */
export function dhashWithImageMagick(path) {
  const output = execFileSync('magick', [path, '-resize', '9x8!', '-colorspace', 'gray', '-depth', '8', 'txt:-'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const pixels = [];
  for (const line of output.split('\n')) {
    const match = /\((\d+)/.exec(line);
    if (match) pixels.push(Number(match[1]));
  }
  if (pixels.length !== 72) throw new Error(`dHash expected 72 pixels for ${path}, got ${pixels.length}`);
  let bits = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const left = pixels[row * 9 + col];
      const right = pixels[row * 9 + col + 1];
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(a, b) {
  let distance = 0;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  while (x) {
    distance += Number(x & 1n);
    x >>= 1n;
  }
  return distance;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function stateFingerprint(record) {
  const material = [
    record.state?.page_class ?? '',
    record.state?.state_class ?? '',
    record.state?.url_class ?? '',
    ...(record.state?.fingerprint_material ?? []).map((item) => String(item).replace(/\s+/g, ' ').slice(0, 120)),
  ];
  if (!material.slice(3).length && record.state?.text) material.push(String(record.state.text).replace(/\s+/g, ' ').slice(0, 200));
  return createHash('sha256').update(material.join('|')).digest('hex').slice(0, 20);
}

export function imageInfo(record, { hasher = dhashWithImageMagick } = {}) {
  const path = record.evidence?.screenshot?.source_path ?? record.evidence?.screenshot?.path;
  if (!path || !existsSync(path)) return { sha256: null, dhash: null, bytes: null };
  const bytes = readFileSync(path).length;
  const sha = sha256File(path);
  let dhash = null;
  try {
    dhash = hasher(path);
  } catch {
    dhash = null;
  }
  return { sha256: sha, dhash, bytes };
}

function representativeScore(record) {
  const label = LABEL_RANK.get(record.label_quality) ?? LABEL_QUALITY.length;
  const verified = record.outcome?.verified ? 0 : 1;
  return [label, verified, record.timestamp ?? '9999', record.decision_id];
}

/** Assign every record a `dedupe` block; returns counts plus the canonical set. */
export function clusterDuplicates(records, { hasher = dhashWithImageMagick, dhashThreshold = 4 } = {}) {
  const parent = new Map();
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const record of records) parent.set(record.decision_id, record.decision_id);

  const byExact = new Map();
  const byFingerprint = new Map();
  const groups = [];
  for (const record of records) {
    if (record.evidence?.screenshot?.sha256) {
      const key = `sha:${record.evidence.screenshot.sha256}`;
      if (byExact.has(key)) union(record.decision_id, byExact.get(key));
      else byExact.set(key, record.decision_id);
    }
    const fingerprint = stateFingerprint(record);
    record.dedupe_fingerprint = fingerprint;
    const key = `${record.state?.page_class ?? 'unknown'}|${fingerprint}`;
    if (byFingerprint.has(key)) union(record.decision_id, byFingerprint.get(key));
    else byFingerprint.set(key, record.decision_id);
  }

  // dHash clustering within the same state family.
  const visualByFamily = new Map();
  for (const record of records) {
    if (!record.evidence?.screenshot?.dhash) continue;
    const family = record.state?.page_class ?? 'unknown';
    if (!visualByFamily.has(family)) visualByFamily.set(family, []);
    visualByFamily.get(family).push(record);
  }
  const visual = [...visualByFamily.values()].flat();
  for (const familyRecords of visualByFamily.values()) {
    for (let i = 0; i < familyRecords.length; i += 1) {
      for (let j = i + 1; j < familyRecords.length; j += 1) {
        const a = familyRecords[i];
        const b = familyRecords[j];
        if (hammingDistance(a.evidence.screenshot.dhash, b.evidence.screenshot.dhash) <= dhashThreshold) {
          union(a.decision_id, b.decision_id);
          groups.push({ a: a.decision_id, b: b.decision_id, kind: 'dhash' });
        }
      }
    }
  }

  const clusters = new Map();
  for (const record of records) {
    const root = find(record.decision_id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(record);
  }

  let duplicates = 0;
  const canonical = [];
  for (const members of clusters.values()) {
    const sorted = members.slice().sort((a, b) => {
      const [la, va, ta, ida] = representativeScore(a);
      const [lb, vb, tb, idb] = representativeScore(b);
      return la - lb || va - vb || String(ta).localeCompare(String(tb)) || String(ida).localeCompare(String(idb));
    });
    const representative = sorted[0];
    representative.dedupe = { role: 'representative', cluster_size: members.length };
    canonical.push(representative);
    for (const member of sorted.slice(1)) {
      member.dedupe = {
        role: 'near_duplicate',
        near_duplicate_of: representative.decision_id,
        similarity: member.evidence?.screenshot?.sha256 === representative.evidence?.screenshot?.sha256 ? 'exact_sha' : 'near',
        cluster_size: members.length,
      };
      duplicates += 1;
    }
  }
  return {
    canonical,
    duplicates,
    clusters: clusters.size,
    dhashAvailable: visual.length > 0,
    pairs_checked: (visual.length * (visual.length - 1)) / 2,
    pairs: groups,
  };
}
