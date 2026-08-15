import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
  console.error('usage: node scripts/verify-pages-fallback.mjs <full-sha>');
  process.exit(2);
}

const contract = JSON.parse(readFileSync(`${root}/.github/codex-publish.json`, 'utf8'));
const remoteName = contract.remote;
const branch = contract.branch;
const workflow = contract.pages?.workflow;
const timeoutMs = Number(contract.pages?.timeout ?? 600) * 1000;
const intervalMs = Number(contract.pages?.interval ?? 5) * 1000;
const remoteUrl = execFileSync('git', ['remote', 'get-url', remoteName], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const repository = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
if (!repository || !workflow) {
  console.error('cannot infer GitHub repository or Pages workflow');
  process.exit(2);
}

const owner = repository[1];
const repo = repository[2];
const site = contract.pages?.site
  ?? `https://${owner}.github.io/${repo === `${owner}.github.io` ? '' : `${repo}/`}`;
const workflowUrl = `https://github.com/${owner}/${repo}/actions/workflows/${workflow}?query=branch%3A${encodeURIComponent(branch)}`;
const commitHref = `/${owner}/${repo}/commit/${sha}`;
const deadline = Date.now() + timeoutMs;
let lastState = 'waiting for workflow listing';

const remoteRef = execFileSync('git', ['ls-remote', remoteName, `refs/heads/${branch}`], {
  cwd: root,
  encoding: 'utf8',
}).trim().split(/\s+/)[0];
if (remoteRef !== sha) {
  console.error(`remote SHA mismatch: expected ${sha}, got ${remoteRef || 'missing'}`);
  process.exit(1);
}

async function text(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      'cache-control': 'no-cache',
      'user-agent': 'board-race-release-check',
    },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

function workflowState(html) {
  const commitAt = html.indexOf(commitHref);
  if (commitAt < 0) return 'pending';
  const rowAt = html.lastIndexOf('<div class="Box-row', commitAt);
  const row = html.slice(Math.max(0, rowAt), commitAt + commitHref.length);
  const label = row.match(/aria-label="([^"]+)"/)?.[1]?.toLowerCase() ?? '';
  if (label.startsWith('completed successfully:')) return 'success';
  if (label.includes('currently running:') || label.includes('queued:')) return 'pending';
  if (label) return `failed:${label}`;
  return 'pending';
}

while (Date.now() < deadline) {
  try {
    const [workflowHtml, liveHtml] = await Promise.all([text(workflowUrl), text(site)]);
    const state = workflowState(workflowHtml);
    const live = liveHtml.includes(sha);
    if (state === 'success' && live) {
      console.log(`repository=${owner}/${repo}`);
      console.log(`branch=${branch}`);
      console.log(`sha=${sha}`);
      console.log(`pages_url=${site}`);
      console.log('workflow_html=success');
      console.log('content_marker=matched');
      console.log('result=pass-public-fallback');
      process.exit(0);
    }
    if (state.startsWith('failed:')) {
      console.error(`Pages workflow did not succeed: ${state.slice(7)}`);
      process.exit(1);
    }
    lastState = `workflow=${state}, content_marker=${live ? 'matched' : 'waiting'}`;
  } catch (error) {
    lastState = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
}

console.error(`Pages fallback timed out: ${lastState}`);
process.exit(1);
