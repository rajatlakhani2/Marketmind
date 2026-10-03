const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Find git.exe
const possibleGitPaths = [
  'C:\\Users\\Honey\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
];

let gitPath = null;
for (const p of possibleGitPaths) {
  if (fs.existsSync(p)) { gitPath = p; break; }
}

if (!gitPath) {
  // Try PATH
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (r.status === 0) gitPath = 'git';
  } catch (e) {}
}

if (!gitPath) {
  console.log('GIT_NOT_FOUND');
  process.exit(1);
}
console.log('Using git:', gitPath);

const dir = 'C:\\Users\\Honey\\OneDrive - G. K. Choksi & Co\\Rajat work\\1. AI\\Share Market\\Share Market';
process.chdir(dir);
console.log('Dir:', process.cwd());

function git(args, opts = {}) {
  const r = spawnSync(gitPath, args, {
    cwd: dir,
    encoding: 'utf8',
    shell: false,
    stdio: 'inherit',
    ...opts,
  });
  return r;
}

// Init (skip if already a repo)
try {
  spawnSync(gitPath, ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
} catch {
  console.log('git init');
  git(['init']);
}

// Add all
console.log('git add .');
spawnSync(gitPath, ['add', '.'], { cwd: dir, encoding: 'utf8', stdio: 'inherit' });

// Commit
console.log('git commit ...');
git(['commit', '-m', 'Initial commit: MarketMind AI with KS-001 Demand & Supply analysis']);

// Remote
console.log('git remote add origin ...');
try {
  git(['remote', 'add', 'origin', 'https://github.com/rajatlakhani2/Marketmind.git']);
} catch (e) {
  console.log('remote may already exist');
}

// Branch
console.log('git branch -M main');
git(['branch', '-M', 'main']);

// Push
console.log('git push -u origin main');
git(['push', '-u', 'origin', 'main']);

console.log('ALL_DONE');
