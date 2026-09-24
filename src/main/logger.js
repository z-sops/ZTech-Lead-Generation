'use strict';

const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(require('electron').app.getPath('userData'), 'logs');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_FILES = 10;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFileName() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `app-${date}.log`);
}

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;
    const rotated = filePath + '.' + Date.now();
    fs.renameSync(filePath, rotated);
    cleanOldLogs();
  } catch {}
}

function cleanOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('app-'))
      .map(f => ({ name: f, time: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    files.slice(MAX_FILES).forEach(f => {
      try { fs.unlinkSync(path.join(LOG_DIR, f.name)); } catch {}
    });
  } catch {}
}

function formatLine(level, category, message, data) {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${level}] [${category}] ${message}`;
  if (data !== undefined) {
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      if (str.length < 500) line += ' ' + str;
      else line += ' ' + str.slice(0, 500) + '...';
    } catch {}
  }
  return line;
}

function writeLine(line) {
  const filePath = getLogFileName();
  rotateIfNeeded(filePath);
  try {
    fs.appendFileSync(filePath, line + '\n', 'utf-8');
  } catch {}
}

const logger = {
  info(category, message, data) {
    writeLine(formatLine('INFO', category, message, data));
  },
  warn(category, message, data) {
    writeLine(formatLine('WARN', category, message, data));
  },
  error(category, message, data) {
    writeLine(formatLine('ERROR', category, message, data));
  },
  ok(category, message, data) {
    writeLine(formatLine('OK', category, message, data));
  },

  getLogDir() {
    return LOG_DIR;
  },

  getLogFiles() {
    try {
      return fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('app-'))
        .sort()
        .reverse()
        .map(f => ({
          name: f,
          path: path.join(LOG_DIR, f),
          size: fs.statSync(path.join(LOG_DIR, f)).size
        }));
    } catch {
      return [];
    }
  },

  exportLogs() {
    const files = this.getLogFiles();
    let combined = '';
    for (const f of files) {
      try {
        combined += `\n=== ${f.name} ===\n`;
        combined += fs.readFileSync(f.path, 'utf-8');
      } catch {}
    }
    return combined;
  }
};

module.exports = { logger };
