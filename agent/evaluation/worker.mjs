import { mkdir, readdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { evaluate } from './typesafe.mjs';

const queue = `${process.env.TYPESAFE_BENCHMARK_DIR || 'out/browser-evaluation'}/queue`;
await mkdir(queue, { recursive: true });
const deadline = Date.now() + 25 * 60_000;
let calls = 0;
console.log('Benchmark API worker ready; maximum 80 requests, 25-minute lifetime.');
while (Date.now() < deadline && calls < 80) {
  if (await access(`${queue}/STOP`).then(() => true, () => false)) break;
  const files = (await readdir(queue)).filter(name => name.endsWith('.request.json')).sort();
  for (const file of files) {
    const output = `${queue}/${file.replace('.request.json', '.response.json')}`;
    if (await access(output).then(() => true, () => false)) continue;
    if (calls >= 80) break;
    const request = JSON.parse(await readFile(`${queue}/${file}`, 'utf8'));
    let result;
    try {
      calls++;
      result = await evaluate({ state: request.state, questions: request.questions });
    } catch (error) {
      result = { error: error.message, code: error.cause?.code };
    }
    await writeFile(`${output}.tmp`, JSON.stringify(result, null, 2));
    await rename(`${output}.tmp`, output);
    console.log(JSON.stringify({ call: calls, latencyMs: result.latencyMs, error: result.error || null }));
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
console.log(`Benchmark API worker stopped after ${calls} requests.`);
