#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const TEST_DIR = path.join(__dirname);
const TEST_FILES = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js') && f !== 'run-all.js')
  .sort();

let totalPassed = 0;
let totalFailed = 0;
let currentTestFile = 0;

function runNext() {
  if (currentTestFile >= TEST_FILES.length) {
    console.log(`\n=== SUMMARY ===`);
    console.log(`Total: ${totalPassed + totalFailed} tests (${totalPassed} passed, ${totalFailed} failed)`);
    console.log(`Files: ${TEST_FILES.length}`);
    process.exit(totalFailed > 0 ? 1 : 0);
    return;
  }

  const file = TEST_FILES[currentTestFile++];
  console.log(`\n--- Running ${file} ---`);

  const child = fork(path.join(TEST_DIR, file), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });

  child.on('close', (code) => {
    const lines = output.trim().split('\n');
    const summaryLine = lines.find(l => l.match(/^\d+ passed, \d+ failed$/)) || lines[lines.length - 1];
    console.log(summaryLine);

    const match = summaryLine.match(/^(\d+) passed, (\d+) failed$/);
    if (match) {
      totalPassed += parseInt(match[1], 10);
      totalFailed += parseInt(match[2], 10);
    } else if (code !== 0) {
      totalFailed += 1;
    }

    runNext();
  });
}

runNext();