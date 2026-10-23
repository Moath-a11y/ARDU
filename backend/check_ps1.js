const fs = require('fs');
const content = fs.readFileSync('C:/Users/PC/.gemini/antigravity-ide/scratch/test_alpha_cloud_challenge.ps1', 'utf8');
const lines = content.split(/\r?\n/);

let inString = false;
let quoteChar = null;
let startLine = 0;
let startCol = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (!inString) {
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
        startLine = i + 1;
        startCol = j + 1;
      }
    } else {
      if (quoteChar === '"' && ch === '`') {
        j++; // backtick escape in double quote
      } else if (ch === quoteChar) {
        // In PS, '' inside single quote or "" inside double quote is an escape if repeated
        if (j + 1 < line.length && line[j + 1] === quoteChar) {
          j++;
        } else {
          inString = false;
          quoteChar = null;
        }
      }
    }
  }
}

if (inString) {
  console.log(`Unterminated string started at line ${startLine}, col ${startCol}: quote ${quoteChar}`);
  console.log('Line content:', lines[startLine - 1]);
} else {
  console.log('All quotes cleanly closed according to PowerShell rules.');
}
