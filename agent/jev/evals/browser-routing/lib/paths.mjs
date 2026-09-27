/** Default locations. Everything overridable from the CLI for tests/CI. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLYWHEEL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultRepos(env = process.env) {
  return {
    main: resolve(env.BROWSER_ROUTING_MAIN_REPO ?? resolve(FLYWHEEL_ROOT, '../../../..')),
    browser: resolve(env.BROWSER_ROUTING_BROWSER_REPO ?? '/Users/buena/Code/blockchain-rust-superteam-poland-browser'),
  };
}

export function storePaths({ root = FLYWHEEL_ROOT } = {}) {
  return {
    root,
    decisions: resolve(root, 'decisions'),
    registry: resolve(root, 'registry'),
    snapshots: resolve(root, 'registry/snapshots'),
    heldout: resolve(root, 'registry/heldout.json'),
    snapshotIndex: resolve(root, 'registry/snapshots.json'),
  };
}

export function repoInstallation({ main, browser }) {
  return {
    main: existsSync(main) ? main : null,
    browser: existsSync(browser) ? browser : null,
    checkout: `${main}${browser ? `; browser worktree ${browser}` : ''}`,
  };
}
