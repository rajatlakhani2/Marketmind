const fs = require('fs');
const path = require('path');

// GitHub Desktop bundles git in its app folder
const gdDir = 'C:\\Users\\Honey\\AppData\\Local\\GitHubDesktop';
const appDirs = fs.readdirSync(gdDir).filter(d => d.startsWith('app-'));
console.log('App dirs:', appDir.join(','));

for (const app of appDirs) {
  const gitDir = path.join(gdDir, app, 'resources', 'app', 'git', 'cmd');
  console.log('Checking:', gitDir, 'exists=' + fs.existsSync(gitDir));
  if (fs.existsSync(gitDir)) {
    const files = fs.readdirSync(gitDir).filter(f => f.includes('git'));
    console.log('  git files:', files.join(','));
  }
}

// Also check the bin folder
const binDir = path.join(gdDir, 'bin');
if (fs.existsSync(binDir)) {
  console.log('bin contents:', fs.readdirSync(binDir).join(','));
}
