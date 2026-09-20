import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { loadSettings } from './config.mjs';
import { acquireProfileLock, saveJson } from './storage.mjs';
import { openBrowser } from './glovo.mjs';
import { verifySetupObservation, setupPolicyDigest } from './setup.mjs';

export async function onboard({ desktop = false } = {}) {
  const settings = await loadSettings();
  const release = await acquireProfileLock(settings.dataDir);
  let session;
  try {
    session = await openBrowser({ ...settings, headless: false, onboard: true, managedSignals: desktop });
    console.log('Sign in manually, select the configured address and merchant, and empty the cart. Do not place an order.');
    if (desktop) {
      console.log('When finished, use the private setup confirmation page.');
      // Reload approved host configuration so correcting an address does not
      // require another browser restart or sign-in.
      const refresh = async () => {
        settings.config = (await loadSettings()).config;
        session.adapter.config = settings.config;
        return settings.config;
      };
      return { settings, session, release, refresh, finish: async () => {
        await refresh();
        const observation = settings.config.expectedAccountLabel ? await session.adapter.observeSetup() : await session.adapter.observe();
        const checks = verifySetupObservation(observation, settings.config);
        await saveJson(join(settings.dataDir, 'onboarded.json'), { storeUrl: settings.config.storeUrl,
          destinationLabel: settings.config.destinationLabel, policyDigest: setupPolicyDigest(settings.config),
          ...checks, confirmedAt: new Date().toISOString() });
        return checks;
      } };
    }
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { await input.question('Press Enter after completing setup in the browser. '); } finally { input.close(); }
    settings.config = (await loadSettings()).config;
    session.adapter.config = settings.config;
    const observation = settings.config.expectedAccountLabel ? await session.adapter.observeSetup() : await session.adapter.observe();
    const checks = verifySetupObservation(observation, settings.config);
    await saveJson(join(settings.dataDir, 'onboarded.json'), { storeUrl: settings.config.storeUrl,
      destinationLabel: settings.config.destinationLabel, policyDigest: setupPolicyDigest(settings.config),
      ...checks, confirmedAt: new Date().toISOString() });
    console.log('Account setup verified. You can start the shopping service.');
  } finally { if (!desktop || !session) { await session?.close(); await release(); } }
}
if (process.argv[1]?.endsWith('/onboard.mjs')) {
  onboard().catch(error => { console.error(error.code || 'onboarding_failed'); process.exitCode = 1; });
}
