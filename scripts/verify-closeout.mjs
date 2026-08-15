import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function requireText(path, snippets) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    failures.push(`missing required knowledge file: ${path}`);
    return;
  }
  const content = readFileSync(absolute, 'utf8');
  for (const snippet of snippets) {
    if (!content.includes(snippet)) failures.push(`${path} is missing: ${snippet}`);
  }
}

function checkGitState() {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  for (const line of status.split('\n').filter(Boolean)) {
    const index = line[0];
    const worktree = line[1];
    if (index === '?' || worktree === '?' || worktree !== ' ') {
      failures.push(`unstaged or untracked release residue: ${line}`);
    }
  }
  execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['diff', '--cached', '--check'], { cwd: root, stdio: 'pipe' });
}

function checkResidueNames() {
  const files = git(['ls-files', '-co', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  const residue = /(?:^|\/)(?:plan|implementation-notes)(?:[-_.].*)?\.(?:md|txt)$|(?:^|\/).*(?:_old|_backup|\.bak|\.orig|\.rej|\.tmp|~)$/i;
  for (const file of files) {
    if (residue.test(file)) failures.push(`workspace residue candidate: ${file}`);
  }
}

function checkEnvironmentContract() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  const keys = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
    .filter(Boolean);
  const allowed = new Set(['VITE_GIT_SHA']);
  for (const key of keys) {
    if (!allowed.has(key)) failures.push(`unexpected tracked .env key: ${key}`);
  }
}

function checkManualViteServers() {
  if (!existsSync('/proc')) return;
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const cwd = readlinkSync(`/proc/${entry.name}/cwd`);
      const argv = readFileSync(`/proc/${entry.name}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean);
      const executable = basename(argv[0] ?? '');
      const entrypoint = argv[1] ?? '';
      const isVite = executable === 'vite'
        || entrypoint === `${root}/node_modules/.bin/vite`
        || entrypoint.startsWith(`${root}/node_modules/vite/bin/vite`);
      if (cwd === root && isVite) {
        failures.push(`manual Vite server still running: pid ${entry.name}`);
      }
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }
}

requireText('AGENTS.md', ['docs/llmwiki.md', 'release:checked']);
requireText('README.md', ['npm run verify:release']);
requireText('docs/llmwiki.md', ['npm run verify:release', 'release:checked']);
checkGitState();
checkResidueNames();
checkEnvironmentContract();
checkManualViteServers();

if (failures.length > 0) {
  for (const failure of failures) console.error(`closeout: ${failure}`);
  process.exit(1);
}

console.log(`closeout contract: OK (${basename(root)})`);
