// Pure helpers only. No Claude hooks, scans or paid APIs are started.
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../../research/typesafe-mod', import.meta.url));
const revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== 'a39e04dc28ebd560050c9c18daed3b080b67b018') throw new Error('Use the pinned typesafe-mod revision recorded in REPORT.md.');
const { buildBatchRequest, pickDecision, readDecisions } = await import(pathToFileURL(resolve(repo, 'hooks/suggest.ts')));
const questions = [{ question: 'Which navigation operation makes progress?', options: [{ label: 'Open details' }, { label: 'Wait' }] }];
const request = buildBatchRequest(questions, 'Visible catalogue result; navigation only.');
const response = { answers: { q0: { choice: 'Open details', confidence: 0.9, probabilities: { 'Open details': 0.95, Wait: 0.05 } } } };
const result = {
  sourceCommit: revision,
  scope: 'Pure helper reproduction using a synthetic provider response. No API calls or hooks.',
  requestKeys: Object.keys(request.questions),
  advisory: readDecisions(response, questions)[0],
  autoAnswerResult: pickDecision(response, questions[0]),
  interpretation: 'The batch request asks for q0; the auto-answer helper reads answers.pick and returns null for this valid batch-shaped response.',
};
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(new URL('./results/mod-response-check.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
