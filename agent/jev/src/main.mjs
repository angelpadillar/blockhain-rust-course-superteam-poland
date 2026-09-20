import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSettings } from './config.mjs';
import { acquireProfileLock } from './storage.mjs';
import { createService } from './server.mjs';
import { createJev } from './jev.mjs';
import { openBrowser } from './glovo.mjs';
import { setupPolicyDigest } from './setup.mjs';

let release, service;
try {
  const settings = await loadSettings();
  const decide = createJev({ apiKey: settings.apiKey, model: settings.config.model });
  release = await acquireProfileLock(settings.dataDir);
  service = await createService({ ...settings, decide, open: () => openBrowser({ ...settings, managedSignals: true }),
    ready: async () => {
      try {
        const marker = JSON.parse(await readFile(join(settings.dataDir, 'onboarded.json'), 'utf8'));
        return marker.storeUrl === settings.config.storeUrl && marker.destinationLabel === settings.config.destinationLabel
          && marker.policyDigest === setupPolicyDigest(settings.config);
      } catch { return false; }
    } });
  await new Promise((resolve, reject) => {
    service.server.once('error', reject); service.server.listen(settings.port, settings.host, resolve);
  });
  console.log(JSON.stringify({ event: 'listening', host: settings.host, port: settings.port, mode: 'prepare_only' }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await service.close(); await release(); process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch (error) {
  if (service) await service.close().catch(() => {});
  if (release) await release();
  console.error(JSON.stringify({ event: 'startup_failed', reason: error.code || 'invalid_configuration_or_runtime' }));
  process.exitCode = 1;
}
