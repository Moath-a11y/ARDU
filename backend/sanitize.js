const fs = require('fs');

let s = fs.readFileSync('C:/Users/PC/.gemini/antigravity-ide/scratch/test_alpha_cloud_challenge.ps1', 'utf8');
s = s.replace(/[\u2014\u2013]/g, '-');
s = s.replace(/[\u201C\u201D]/g, '"');
s = s.replace(/[\u2018\u2019]/g, "'");
s = s.replace(/[^\x00-\x7F]/g, '');

fs.writeFileSync('C:/Users/PC/.gemini/antigravity-ide/scratch/test_alpha_cloud_challenge.ps1', s, 'ascii');
fs.writeFileSync('scripts/test_alpha_cloud_challenge.ps1', s, 'ascii');
console.log('Sanitized to pure ASCII successfully.');
