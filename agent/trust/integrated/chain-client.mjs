import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export function bridgePaths() {
  const roots = [resolve(here, '../project'), resolve(here, '../../..')];
  const binary = process.env.GIFTING_BRIDGE_BIN || [resolve(here, 'bin/gifting_bridge'), ...roots.map(root => resolve(root, 'target/debug/examples/gifting_bridge'))].find(existsSync);
  const program = process.env.GIFTING_PROGRAM_SO || [resolve(here, 'bin/gift_campaign.so'), ...roots.map(root => resolve(root, 'target/deploy/gift_campaign.so'))].find(existsSync);
  if (!binary || !program) throw new Error('local_solana_bridge_not_built');
  if (createHash('sha256').update(readFileSync(program)).digest('hex') !== '5f04b46558cf0427dda612e53f6bec921bb67fc7e08b10f4a868e08113e12e00') throw new Error('unreviewed_solana_program_binary');
  return { binary, program };
}

export class LocalChain {
  constructor(paths = bridgePaths()) {
    this.child = spawn(paths.binary, [], { env: { ...process.env, GIFTING_PROGRAM_SO: paths.program }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = null; this.dead = false; this.stderr = '';
    this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-4000); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const pending = this.pending; if (!pending) return;
      this.pending = null; clearTimeout(pending.timer);
      try { pending.resolve(JSON.parse(line)); } catch { pending.reject(new Error('invalid_chain_response')); }
    });
    const died = () => {
      this.dead = true;
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('local_chain_unavailable')); this.pending = null; }
    };
    this.child.on('error', died); this.child.on('exit', died);
  }
  request(payload) {
    if (this.dead) return Promise.reject(new Error('local_chain_unavailable'));
    if (this.pending) return Promise.reject(new Error('chain_operation_in_progress'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; this.child.kill(); reject(new Error('chain_response_uncertain')); }, 15000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(payload) + '\n', error => { if (error) { clearTimeout(timer); this.pending = null; reject(error); } });
    });
  }
  close() { this.child.kill(); }
}
