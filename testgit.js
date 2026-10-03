const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const git = 'C:\\Users\\Honey\\AppData\\Local\\Programs\\Git\\cmd\\git.exe';
const dir = path.join('C:\\Users\\Honey\\OneDrive - G. K. Choksi & Co', 'Rajat work', '1. AI', 'Share Market', 'Share Market');

if (!fs.existsSync(git)) { console.log('GIT_NOT_FOUND'); process.exit(1); }
if (!fs.existsSync(dir)) { console.log('DIR_NOT_FOUND:', dir); process.exit(1); }

console.log('Dir:', dir);
try {
  spawnSync(git, ['--version'], { encoding: 'utf8', stdio: 'inherit' });
} catch (e) { console.log('git error:', e.message); }
