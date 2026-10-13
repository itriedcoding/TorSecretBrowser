'use strict';

/**
 * syntax-check.js
 * ---------------------------------------------------------------------------
 * Runs `node --check` over every JavaScript file in src/ and scripts/.
 * Fast, dependency-free guard that catches typos before launch.
 * Usage: npm run syntax-check
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['src', 'scripts'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.isFile() && full.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

let files = [];
for (const t of TARGETS) {
  const dir = path.join(ROOT, t);
  if (fs.existsSync(dir)) walk(dir, files);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    process.stdout.write(`ok    ${path.relative(ROOT, file)}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`FAIL  ${path.relative(ROOT, file)}\n`);
    process.stdout.write(String(err.stderr || err.message) + '\n');
  }
}

process.stdout.write(`\n${files.length - failed}/${files.length} files passed syntax check.\n`);
process.exit(failed === 0 ? 0 : 1);
