#!/usr/bin/env node
/**
 * Project-local control for the efficiency observer (v1 policy).
 *
 *   node control.mjs status            show preset, effective config and posture
 *   node control.mjs preset safe       validated production policy (default)
 *   node control.mjs preset observe    telemetry only, no projection/apply
 *   node control.mjs preset off        plugin disabled, zero changes (kill switch)
 *   node control.mjs preset experimental-gateway   safe + lazy gateway (opt-in)
 *   node control.mjs preset list       list available presets
 *   node control.mjs enable | disable  flip the kill switch only
 *   node control.mjs set key=value ... edit individual keys
 *
 * Only touches <project>/.opencode/jev-efficiency.json. Global OpenCode
 * settings are never modified.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(HERE, '..', '..', '..');
const CONFIG_PATH = join(PROJECT_DIR, '.opencode', 'jev-efficiency.json');

/** Validated production policy — frozen as v1 (see reports/runtime/AGENT-EFFICIENCY-V1.md). */
export const SAFE_PRESET = {
  enabled: true,
  mode: 'observe',
  resultAdmissionMode: 'deterministic',
  shortlistMode: 'soft',
  toolExposureMode: 'off',
  routerMode: 'observe',
  routerThreshold: 0.6,
  singleActionThreshold: 0,
  maxTools: 3,
  requiredTools: [],
  preset: 'safe',
};

export const PRESETS = {
  safe: SAFE_PRESET,
  observe: {
    ...SAFE_PRESET,
    resultAdmissionMode: 'observe',
    shortlistMode: 'observe',
    preset: 'observe',
  },
  off: {
    enabled: false,
    preset: 'off',
  },
  'experimental-gateway': {
    ...SAFE_PRESET,
    toolExposureMode: 'gateway',
    preset: 'experimental-gateway',
  },
};

export const RECOMMENDED_DEFAULTS = SAFE_PRESET;

const read = () => {
  try {
    return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
};
const write = (doc) => {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`wrote ${CONFIG_PATH}`);
};

const command = process.argv[2] ?? 'status';
if (command === 'preset') {
  const name = process.argv[3] ?? '';
  if (name === 'list' || name === '') {
    console.log(`presets: ${Object.keys(PRESETS).join(', ')}`);
  } else if (PRESETS[name]) {
    write({ ...PRESETS[name] });
    console.log(`applied preset "${name}" (project-local only)`);
    if (name === 'off') console.log('efficiency observer DISABLED. Re-enable with: preset safe');
    if (name === 'experimental-gateway') console.log('experimental: lazy gateway enabled — lane must keep `shell`');
  } else {
    console.error(`unknown preset "${name}". available: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(2);
  }
} else if (command === 'disable') {
  const doc = { ...read(), enabled: false, preset: 'off' };
  write(doc);
  console.log('efficiency observer DISABLED (kill switch). Re-enable with: node control.mjs enable');
} else if (command === 'enable') {
  const doc = { ...read(), enabled: true };
  write(doc);
  console.log('efficiency observer ENABLED');
} else if (command === 'reset') {
  write({ ...SAFE_PRESET });
  console.log('restored preset "safe"');
} else if (command === 'set') {
  const doc = read();
  for (const pair of process.argv.slice(3)) {
    const i = pair.indexOf('=');
    if (i === -1) continue;
    const key = pair.slice(0, i);
    const raw = pair.slice(i + 1);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    doc[key] = value;
  }
  doc.preset = doc.preset ?? 'custom';
  write(doc);
} else {
  const doc = read();
  const effective = { ...SAFE_PRESET, ...doc };
  console.log(
    JSON.stringify(
      {
        configPath: CONFIG_PATH,
        present: existsSync(CONFIG_PATH),
        preset: effective.preset ?? 'custom',
        presetSource: doc.preset === effective.preset ? 'config' : 'default',
        onDisk: doc,
        effective,
      },
      null,
      2,
    ),
  );
}
