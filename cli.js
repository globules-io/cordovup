#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { stripVTControlCharacters } = require('node:util');

const CONFIG_NAME = 'config.xml';

function quoteArg(arg) {
  const text = String(arg);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function spawn(command, args, stdio) {
  const options = {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    stdio,
    env: Object.assign({}, process.env, {
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      npm_config_color: 'false',
    }),
  };

  // Windows needs a shell to run npm.cmd and cordova.cmd. Pass one command
  // string so Node does not warn about an args array combined with shell.
  if (process.platform === 'win32') {
    const line = [command].concat(args).map(quoteArg).join(' ');
    return spawnSync(line, Object.assign({ shell: true }, options));
  }

  return spawnSync(command, args, options);
}

// npm outdated --depth=0 prints a column table and exits 1 when something is outdated.
function parseOutdated(text) {
  const lines = stripVTControlCharacters(String(text || '')).split(/\r?\n/);
  const rows = [];
  let inTable = false;

  for (const line of lines) {
    const cells = line.trim().split(/\s{2,}/);
    if (!inTable) {
      if (cells[0] === 'Package' && cells[1] === 'Current' && cells[2] === 'Wanted' && cells[3] === 'Latest') {
        inTable = true;
      }
      continue;
    }
    if (!line.trim()) continue;
    const name = cells[0];
    const latest = cells[3];
    if (!name || !latest) continue;
    rows.push({
      name,
      current: cells[1],
      wanted: cells[2],
      latest,
    });
  }

  return rows;
}

function npmOutdated() {
  const result = spawn('npm', ['outdated', '--depth=0'], ['ignore', 'pipe', 'pipe']);
  if (result.error) {
    throw new Error('Could not run npm. ' + result.error.message);
  }

  const stdout = result.stdout || '';
  const rows = parseOutdated(stdout);
  if (result.status !== 0 && result.status !== 1) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error('npm outdated --depth=0 failed');
  }
  if (!rows.length && result.status === 1) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (stdout.trim()) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n');
    throw new Error('npm outdated --depth=0 failed');
  }
  return rows;
}

function pluginName(block) {
  const match = block.match(/<plugin\b[^>]*\bname\s*=\s*(['"])([^'"]+)\1/);
  return match ? match[2] : '';
}

function pluginBlocks(xml) {
  const re = /[ \t]*<plugin\b[^>]*\/>|[ \t]*<plugin\b[^>]*>[\s\S]*?<\/plugin>/g;
  const blocks = [];
  let match;
  while ((match = re.exec(xml))) {
    const block = match[0];
    const name = pluginName(block);
    if (!name) continue;
    blocks.push({ name, block });
  }
  return blocks;
}

function replaceVersion(block, latest) {
  const re = /(<plugin\b[^>]*?\bspec\s*=\s*)(['"])([^'"]*)\2/;
  if (!re.test(block)) {
    return block.replace(/<plugin\b/, '<plugin spec="' + latest + '"');
  }
  return block.replace(re, (full, pre, quote, spec) => {
    const prefix = spec.match(/^(?:\^|~|>=|<=|>|<|=)/);
    return pre + quote + (prefix ? prefix[0] : '') + latest + quote;
  });
}

function newlineOf(xml) {
  return xml.includes('\r\n') ? '\r\n' : '\n';
}

function toNewline(text, nl) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, nl);
}

function putBack(xml, blocks) {
  const names = new Set(blocks.map(pluginName));
  let next = xml;
  for (const existing of pluginBlocks(xml)) {
    if (names.has(existing.name)) {
      next = next.replace(existing.block, '');
    }
  }

  const end = next.lastIndexOf('</widget>');
  if (end === -1) {
    throw new Error('config.xml has no </widget>');
  }

  const nl = newlineOf(next);
  next = next.replace(/(?:\r?\n){3,}/g, nl + nl);
  const refreshedEnd = next.lastIndexOf('</widget>');
  const head = next.slice(0, refreshedEnd).replace(/[ \t]+$/, '').replace(/(?:\r?\n)+$/, '');
  const body = blocks
    .map((block) => toNewline(block, nl).replace(/[ \t\r\n]+$/, ''))
    .join(nl);
  return head + nl + body + nl + next.slice(refreshedEnd);
}

function isVersion(value) {
  return /^\d+\.\d+\.\d+/.test(String(value || ''));
}

function versionParts(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// npm outdated can list a "latest" that is older than what is installed.
function isNewer(latest, current) {
  const next = versionParts(latest);
  const installed = versionParts(current);
  if (!next || !installed) return Boolean(next);
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}

function selectable(outdated, plugins) {
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  return outdated
    .filter((row) => byName.has(row.name) && isVersion(row.latest) && isNewer(row.latest, row.current))
    .map((row) => {
      const plugin = byName.get(row.name);
      return {
        name: row.name,
        current: row.current,
        latest: row.latest,
        block: plugin.block,
        nextBlock: replaceVersion(plugin.block, row.latest),
      };
    });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

function runVisible(command, args) {
  const result = spawn(command, args, 'inherit');
  if (result.error) {
    throw new Error('Could not run ' + command + '. ' + result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' failed');
  }
}

async function choose(rows) {
  const allLine = rows.length + 1;
  const noneLine = rows.length + 2;

  console.log('');
  rows.forEach((row, index) => {
    console.log('  ' + (index + 1) + '. ' + row.name + '  ' + row.current + ' -> ' + row.latest);
  });
  console.log('  ' + allLine + '. all');
  console.log('  ' + noneLine + '. none');
  console.log('');

  for (;;) {
    const answer = await ask('Line number: ');
    const line = Number(answer);
    if (Number.isInteger(line) && line >= 1 && line <= noneLine) {
      return line;
    }
    console.log('Enter a line number from 1 to ' + noneLine + '.');
  }
}

async function main() {
  const configPath = path.join(process.cwd(), CONFIG_NAME);
  if (!fs.existsSync(configPath)) {
    throw new Error('No config.xml in the current directory. Run this inside a Cordova project.');
  }

  console.log('Checking for plugin updates...');
  const outdated = npmOutdated();
  const xml = fs.readFileSync(configPath, 'utf8');
  const rows = selectable(outdated, pluginBlocks(xml));

  if (!rows.length) {
    console.log('No plugin updates.');
    return;
  }

  const line = await choose(rows);
  const noneLine = rows.length + 2;
  const allLine = rows.length + 1;
  if (line === noneLine) {
    console.log('No plugins updated.');
    return;
  }

  const selected = line === allLine ? rows : [rows[line - 1]];
  const saved = selected.map((row) => row.nextBlock);

  for (const row of selected) {
    console.log('Removing ' + row.name + '...');
    runVisible('cordova', ['plugin', 'rm', row.name, '--force']);
  }

  const fresh = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, putBack(fresh, saved));
  console.log('Updated config.xml');

  console.log('Running cordova prepare...');
  runVisible('cordova', ['prepare']);
  console.log('Done.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  parseOutdated,
  pluginBlocks,
  replaceVersion,
  putBack,
  selectable,
};
