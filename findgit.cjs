const fs = require('fs');

const paths = [
  'C:\\Users\\Honey\\AppData\\Local\\Programs\\Git',
  'C:\\Program Files\\Git',
  'C:\\Program Files (x86)\\Git',
  'C:\\Users\\Honey\\AppData\\Local\\GitHubDesktop',
];

for (const p of paths) {
  console.log(p + ' exists=' + fs.existsSync(p));
  if (fs.existsSync(p)) {
    console.log('  items: ' + fs.readdirSync(p).slice(0, 10).join(','));
  }
}
