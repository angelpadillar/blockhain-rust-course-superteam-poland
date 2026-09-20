import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRecord, hashArtifact, hashObservation, verifyEvidence } from '../evidence.mjs';

// Offline only. The caller supplies real captures and their exact prior event
// hashes. The browser-serving process has no endpoint that can upload artifacts.
export async function attachBoundaryEvidence({ receiptPath, capturesPath, outputPath }) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const captures = JSON.parse(await readFile(capturesPath, 'utf8'));
  if (!Array.isArray(captures) || captures.length > 10) throw new Error('invalid_capture_manifest');
  let chain = receipt.chain;
  const artifacts = {}, manifest = [];
  for (const capture of captures) {
    const source = chain.find(entry => entry.hash === capture.eventHash && entry.record.type === capture.stage);
    if (!source || !['quote', 'approval', 'confirmation'].includes(capture.stage)) throw new Error('capture_stage_hash_mismatch');
    const screenshotPath = resolve(dirname(capturesPath), capture.screenshotPath);
    const observationPath = resolve(dirname(capturesPath), capture.observationPath);
    const bytes = await readFile(screenshotPath);
    // Preserve the browser's PNG or JPEG bytes; this does not independently prove its
    // visual contents. Root's browser check records how the pixels were captured.
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217;
    if(!png&&!jpeg)throw new Error('screenshot_format_unsupported');
    const observation = JSON.parse(await readFile(observationPath, 'utf8'));
    const evidence = { screenshotSha256: hashArtifact(bytes), observationSha256: hashObservation(observation) };
    const record = source.record;
    chain = appendRecord(chain, { type: 'boundary_evidence', at: Math.max(Date.now(), chain.at(-1).record.at),
      stage: capture.stage, eventHash: capture.eventHash, mandateId: record.mandateId, quoteId: record.quoteId,
      ...(record.approvalId ? { approvalId: record.approvalId } : {}),
      ...(record.confirmationId ? { confirmationId: record.confirmationId } : {}), evidence });
    artifacts[evidence.screenshotSha256] = { kind: 'screenshot', bytes };
    artifacts[evidence.observationSha256] = { kind: 'observation', observation };
    manifest.push({ stage: capture.stage, eventHash: capture.eventHash, ...evidence,
      screenshotPath: relative(dirname(outputPath), screenshotPath), observationPath: relative(dirname(outputPath), observationPath) });
  }
  const verification = verifyEvidence({ chain, artifacts, requireBoundaryEvidence: true });
  if (!verification.valid) throw new Error(`evidence_verification_failed:${verification.issues.map(item => item.code).join(',')}`);
  const result = { ...receipt, chain, verification, boundaryArtifacts: manifest,
    boundaryScope: 'Real local browser captures attached to simulated events. No wallet signature, real merchant fact attestation, or chain deployment.',
    headHashToAnchorSeparately: verification.headHash };
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [receiptPath, capturesPath, outputPath] = process.argv.slice(2).map(path => resolve(path));
  if (!receiptPath || !capturesPath || !outputPath) throw new Error('usage: attach-evidence.mjs receipt.json captures.json new-output.json');
  const result = await attachBoundaryEvidence({ receiptPath, capturesPath, outputPath });
  process.stdout.write(JSON.stringify({ valid: result.verification.valid, headHash: result.verification.headHash }) + '\n');
}
