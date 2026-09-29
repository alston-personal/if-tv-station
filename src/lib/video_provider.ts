import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type VideoProviderId = 'h3_colab';

export interface VideoProviderRequest {
  provider: VideoProviderId;
  prompt: string;
  referenceImages: string[];
  durationSeconds: number;
  outputPath: string;
  jobId?: string;
  segmentId?: string | number;
  onProgress?: (message: string) => void;
}

function requireFile(filePath: string, label: string) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error(`${label} not found or empty: ${filePath}`);
  }
}

function safeId(value: unknown, fallback: string) {
  return String(value ?? fallback).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 48) || fallback;
}

export async function generateVideoWithProvider(request: VideoProviderRequest): Promise<void> {
  if (request.provider !== 'h3_colab') {
    throw new Error(`Unsupported video provider: ${request.provider}`);
  }

  const refs = request.referenceImages.filter(Boolean);
  if (refs.length < 1 || refs.length > 9) {
    throw new Error('MiniMax H3 requires 1-9 reference images.');
  }
  refs.forEach((file, index) => requireFile(file, `reference image ${index + 1}`));

  const duration = Math.max(4, Math.min(15, Math.round(request.durationSeconds)));
  const skillDir = process.env.MINIMAX_H3_SKILL_DIR
    || path.join(process.env.HOME || '/home/ubuntu', '.codex', 'skills', 'minimax-h3-colab');
  const runner = process.env.MINIMAX_H3_RUNNER
    || path.join(skillDir, 'scripts', 'runner.py');

  requireFile(runner, 'MiniMax H3 runner');

  const jobId = safeId(request.jobId, 'iftv');
  const segmentId = safeId(request.segmentId, 'segment');
  const workDir = path.join('/tmp', `iftv_h3_${jobId}_${segmentId}`);
  fs.mkdirSync(workDir, { recursive: true });

  const promptPath = path.join(workDir, 'prompt.txt');
  const manifestPath = path.join(workDir, 'manifest.json');
  const outputDir = path.join(workDir, 'outputs');
  fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(promptPath, request.prompt, 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({
    jobs: [{
      title: `iftv_${jobId}_${segmentId}`,
      reference_images: refs,
      prompt_file: promptPath,
      duration_seconds: duration,
      output_name: 'segment'
    }]
  }, null, 2), 'utf8');

  const python = process.env.MINIMAX_H3_PYTHON || 'python3';
  const gpu = process.env.MINIMAX_H3_GPU || 'A100';
  const timeout = Number(process.env.MINIMAX_H3_TIMEOUT_SECONDS || '10800');

  request.onProgress?.('Checking Colab quota and authentication...');
  await execFileAsync(python, [runner, 'usage', '--json'], {
    cwd: skillDir,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: process.env
  });

  request.onProgress?.(`Generating H3 clip on Colab (${gpu})...`);
  const args = [
    runner,
    'batch',
    '--manifest', manifestPath,
    '--gpu', gpu,
    '--timeout', String(timeout),
    '--output-dir', outputDir
  ];
  if (process.env.MINIMAX_H3_HIGH_MEM === '0') args.push('--no-high-mem');

  await execFileAsync(python, args, {
    cwd: skillDir,
    timeout: (timeout + 120) * 1000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env
  });

  const candidates = [
    path.join(outputDir, 'segment.mp4'),
    ...fs.readdirSync(outputDir)
      .filter((name) => name.toLowerCase().endsWith('.mp4'))
      .map((name) => path.join(outputDir, name))
  ];
  const generated = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
  if (!generated) {
    throw new Error(`MiniMax H3 completed without an MP4 output in ${outputDir}`);
  }

  fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
  fs.copyFileSync(generated, request.outputPath);
  requireFile(request.outputPath, 'MiniMax H3 output');
  request.onProgress?.(`H3 clip ready: ${request.outputPath}`);
}
