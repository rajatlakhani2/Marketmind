const { execSync } = require('child_process');
const git = String.raw`C:\Users\Honey\AppData\Local\Programs\Git\cmd\git.exe`;
const dir = String.raw`C:\Users\Honey\OneDrive - G. K. Choksi & Co\Rajat work\1. AI\Share Market\Share Market`;

try {
  execSync(`"${git}" --version`, { encoding: 'utf8' });
  console.log('git OK');
} catch (e) {
  console.log('git NOT FOUND:', git);
  process.exit(1);
}

try {
  execSync(`"${git}" rev-parse --is-inside-work-tree`, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
} catch {
  console.log('git init ...');
  execSync(`"${git}" init`, { cwd: dir, stdio: 'inherit' });
}

console.log('git add .');
execSync(`"${git}" add .`, { cwd: dir, stdio: 'pipe' });

console.log('git commit ...');
execSync(`"${git}" commit -m "Initial commit: MarketMind AI with KS-001 Demand & Supply analysis"`, { cwd: dir, stdio: 'inherit' });

console.log('COMMIT_DONE');
