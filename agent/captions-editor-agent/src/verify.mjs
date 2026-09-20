import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, Stop } from './policy.mjs';
const exec = promisify(execFile);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(k)));
async function run(binary, args, timeout = 60_000) {
  try { return await exec(binary, args, { timeout, maxBuffer: 4 * 1024 ** 2, env: cleanEnv() }); }
  catch (e) { throw new Stop(`${binary}_verification_failed`, { exitCode: e.code }); }
}
export async function probe(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  return JSON.parse(stdout);
}
export function checkMetadata(source, output, task) {
  const v = output.streams?.find(s => s.codec_type === 'video'), original = source.streams?.find(s => s.codec_type === 'video');
  const [n, d = 1] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number), fps = n / d;
  const target = task.trimEnd - task.trimStart, duration = Number(output.format?.duration);
  const minimumFrameRate = 23.976;
  const frameRateAcceptable = Number.isFinite(fps) && fps >= minimumFrameRate;
  // A low frame rate must never widen the permitted duration loss.
  const tolerance = Math.min(0.1, Math.max(2 / (Number.isFinite(fps) && fps > 0 ? fps : 30), 0.09));
  return { expectedDuration: target, duration, tolerance, width: v?.width ?? null, height: v?.height ?? null,
    frameRate: Number.isFinite(fps) ? fps : null, minimumFrameRate, frameRateAcceptable,
    durationMatches: Number.isFinite(duration) && Math.abs(duration - target) <= tolerance,
    portrait916: !!v && Math.abs(v.width / v.height - 9 / 16) < 0.001,
    preservesDimensions: !!v && !!original && v.width === original.width && v.height === original.height,
    audioPresent: !!output.streams?.some(s => s.codec_type === 'audio'),
    audioExpected: !!source.streams?.some(s => s.codec_type === 'audio'),
    captionTrackPresent: !!output.streams?.some(s => s.codec_type === 'subtitle'),
    codec: v?.codec_name ?? null };
}
const words = text => (text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').match(/[a-z0-9]+/g) || []);
export function captionEvidence(expected, outputText, sourceText) {
  const expectedWords = [...new Set(words(expected))], out = new Set(words(outputText)), src = new Set(words(sourceText));
  const matches = expectedWords.filter(w => out.has(w));
  const newMatches = matches.filter(w => !src.has(w));
  return { expectedWords, matchedWords: matches, newlyVisibleWords: newMatches,
    passed: expectedWords.length > 0 && matches.length === expectedWords.length && newMatches.length >= Math.min(2, expectedWords.length) };
}
async function ocrFrames(path, directory, duration, offset = 0) {
  const items = []; await mkdir(directory, { recursive: true, mode: 0o700 });
  // Deterministic evenly spaced samples. Caption words may appear one at a time.
  const count = Math.min(20, Math.max(8, Math.ceil(duration * 3)));
  for (let i = 0; i < count; i++) {
    const time = offset + (i + 0.5) * duration / count, frame = join(directory, `frame-${String(i).padStart(2, '0')}.png`);
    await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-ss', time.toFixed(3), '-i', path, '-frames:v', '1', frame]);
    const { stdout } = await run('tesseract', [frame, 'stdout', '--psm', '11', '-l', 'eng']);
    items.push({ time, frame: frame.split('/').at(-1), text: stdout.trim() });
  }
  return items;
}
export async function verifyExport({ source, output, task, directory }) {
  const [src, result, file] = await Promise.all([probe(source), probe(output), stat(output)]);
  const checks = checkMetadata(src, result, task);
  assert(file.size > 1000 && file.size <= 200 * 1024 ** 2, 'export_size_invalid');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], 120_000);
  const [renderedFrames, sourceFrames] = await Promise.all([
    ocrFrames(output, join(directory, 'output-frames'), checks.expectedDuration),
    ocrFrames(source, join(directory, 'source-frames'), checks.expectedDuration, task.trimStart),
  ]);
  const captions = captionEvidence(task.expectedCaption, renderedFrames.map(x => x.text).join(' '), sourceFrames.map(x => x.text).join(' '));
  const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
  return { passed: checks.durationMatches && checks.frameRateAcceptable && checks.portrait916 && checks.preservesDimensions && (!checks.audioExpected || checks.audioPresent)
      && captions.passed && (!task.requireSubtitleTrack || checks.captionTrackPresent),
    ...checks, sampledCaptionWordsPresent: captions.passed, captionTranscriptVerified: false, captions, fullDecodePassed: true, bytes: file.size, sha256,
    captionEvidenceType: 'sampled-visible-word-presence-not-transcript-verification', sourceVisualIdentityVerified: false,
    captionRequirement: task.requireSubtitleTrack ? 'embedded-track-and-visible-text' : 'visible-text',
    renderedFrames, sourceFrames };
}
