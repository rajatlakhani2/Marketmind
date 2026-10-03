const { execSync } = require('child_process');
const path = require('path');

const git = 'C:\\Users\\Honey\\AppData\\Local\\Programs\\Git\\cmd\\git.exe';
const dir = String.raw`C:\Users\Honey\OneDrive - G. K. Choksi & Co\Rajat work\1. AI\Share Market\Share Market`;

process.chdir(dir);
console.log('git --version');
console.log(execSync(`"${git}" --version`, { encoding: 'utf8' }));

try {
  execSync(`"${git}" rev-parse --is-inside-work-tree`, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
} catch {
  console.log('Initializing repo...');
  execSync(`"${git}" init`, { cwd: dir, encoding: 'utf8', stdio: 'inherit' });
}

console.log('git add .');
execSync(`"${git}" add .`, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

console.log('git commit ...');
execSync(`"${git}" commit -m "Initial commit: MarketMind AI with KS-001 Demand & Supply analysis"`, { cwd: dir, encoding: 'utf8', stdio: 'inherit' });

console.log('DONE');
