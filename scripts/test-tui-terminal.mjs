import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import stringWidth from 'string-width';

const SCENARIO_DEADLINE_MS = 8_000;
const gracefulRepeatCount = Number(process.env.BAZFRAME_TUI_GRACEFUL_REPEATS ?? '1');
if (!Number.isInteger(gracefulRepeatCount) || gracefulRepeatCount < 1 || gracefulRepeatCount > 10) {
  throw new Error('BAZFRAME_TUI_GRACEFUL_REPEATS must be an integer from 1 through 10.');
}
const projectRoot = process.cwd();
const npmExecPath = process.env.npm_execpath;
if (npmExecPath === undefined) throw new Error('Run terminal validation through npm.');
for (const command of ['tmux', 'script']) requireCommand(command);

const temporaryRoot = mkdtempSync(join(tmpdir(), 'bazframe-tui-terminal-'));
const packageDirectory = join(temporaryRoot, 'package');
const consumer = join(temporaryRoot, 'consumer');
const stateRoot = join(temporaryRoot, 'state');
let activeSocket;
let tarball;
const evidence = [];

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  cleanup();
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
});

try {
  mkdirSync(packageDirectory, { recursive: true });
  const packed = JSON.parse(execFileSync(process.execPath, [npmExecPath, 'pack', '--json', '--pack-destination', packageDirectory], {
    cwd: projectRoot,
    encoding: 'utf8'
  }));
  tarball = join(packageDirectory, packed[0].filename);
  mkdirSync(consumer, { recursive: true });
  execFileSync(process.execPath, [npmExecPath, 'init', '-y'], { cwd: consumer, stdio: 'ignore' });
  execFileSync(process.execPath, [npmExecPath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
    stdio: 'ignore'
  });

  const packageRoot = join(consumer, 'node_modules', 'bazframe-2-prototype');
  const executable = process.platform === 'win32'
    ? join(consumer, 'node_modules', '.bin', 'bazframe.cmd')
    : join(consumer, 'node_modules', '.bin', 'bazframe');
  prepareState(stateRoot);

  evidence.push(runScenario('resize', executable, packageRoot, ({ session, deadline }) => {
    waitForCurrentText(session, 'Status: Ready', deadline);
    assertAlternate(session, '1');
    sendLiteral(session, '2');
    actAndWaitForCurrentText(session, () => sendKey(session, 'Enter'), 'Available skills', deadline);
    actAndWaitForCurrentText(session, () => resize(session, 80, 16), '<- Profiles /', deadline);
    const leadingBlankRowsAfter16 = assertTopAligned(session);
    actAndWaitForCurrentText(session, () => {
      resize(session, 80, 24);
      sendKey(session, 'Tab');
    }, '┃Available skills', deadline);
    const leadingBlankRowsAfter24 = assertTopAligned(session);
    actAndWaitForCurrentText(session, () => {
      resize(session, 80, 30);
      sendKey(session, 'Tab');
      sendKey(session, 'Tab');
    }, '┃Included skills', deadline);
    const leadingBlankRowsAfter30 = assertTopAligned(session);
    actAndWaitForCurrentText(session, () => resize(session, 70, 20), '<- Profiles /', deadline);
    actAndWaitForCurrentText(
      session,
      () => resize(session, 59, 15),
      'Terminal too small (59x15); minimum 60x16.',
      deadline
    );
    actAndWaitForCurrentText(session, () => resize(session, 80, 24), 'Source references:', deadline);
    sendLiteral(session, 'q');
    return {
      evidence: {
        sizes: ['80x24 (initial)', '80x16', '80x24', '80x30', '70x20', '59x15', '80x24'],
        leadingBlankRowsAfterSameWidthResize: {
          '80x16': leadingBlankRowsAfter16,
          '80x24': leadingBlankRowsAfter24,
          '80x30': leadingBlankRowsAfter30
        }
      },
      expectedStatus: 0
    };
  }));

  evidence.push(runScenario('handled-lock-error', executable, packageRoot, ({ session, deadline, home }) => {
    const lockDirectory = join(home, 'locks');
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(join(lockDirectory, 'state.lock'), `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      command: 'terminal-validation-fixture',
      target: home,
      token: randomUUID()
    })}\n`, { mode: 0o600 });
    waitForCurrentText(session, 'Status: Ready', deadline);
    assertAlternate(session, '1');
    sendLiteral(session, '2');
    actAndWaitForCurrentText(session, () => sendLiteral(session, 'c'), 'Create profile', deadline);
    sendLiteral(session, 'reviewer');
    actAndWaitForCurrentText(session, () => sendKey(session, 'Enter'), 'Bazframe state is busy', deadline);
    actAndWaitForCurrentText(session, () => sendKey(session, 'Escape'), 'c create', deadline);
    sendLiteral(session, 'q');
    return { handledError: 'LOCK_BUSY', expectedStatus: 0 };
  }));

  evidence.push(runScenario('editor-handoff', executable, packageRoot, ({ session, deadline, marker }) => {
    beginEditorLaunch(session, deadline);
    waitForMarker(`${marker}.editor-started`, 'started\n', deadline, session);
    assertAlternate(session, '0');
    const terminalState = readFileSync(`${marker}.editor-terminal`, 'utf8');
    if (terminalState.includes('-icanon')) throw scenarioError(session, 'editor inherited a raw terminal');
    publishMarker(`${marker}.editor-release`, 'release\n');
    waitForCurrentText(session, 'Editor exited successfully', deadline);
    assertAlternate(session, '1');
    sendLiteral(session, 'q');
    return {
      expectedStatus: 0,
      evidence: { editor: 'cooked-blocking-success', alternateScreenHandoff: true }
    };
  }, undefined, 'blocking-success'));

  evidence.push(runScenario('editor-ctrl-c', executable, packageRoot, ({ session, deadline, marker }) => {
    beginEditorLaunch(session, deadline);
    waitForMarker(`${marker}.editor-started`, 'started\n', deadline, session);
    assertAlternate(session, '0');
    sendKey(session, 'C-c');
    waitForMarker(`${marker}.editor-interrupted`, 'interrupted\n', deadline, session);
    waitForCurrentText(session, 'Editor exited with status 130', deadline);
    assertAlternate(session, '1');
    sendLiteral(session, 'q');
    return {
      expectedStatus: 0,
      evidence: { editor: 'ctrl-c-interrupted-child-parent-resumed' }
    };
  }, undefined, 'interruptible'));

  evidence.push(runScenario('editor-nonzero', executable, packageRoot, ({ session, deadline }) => {
    beginEditorLaunch(session, deadline);
    waitForCurrentText(session, 'Editor exited with status 7', deadline);
    assertAlternate(session, '1');
    sendLiteral(session, 'q');
    return { expectedStatus: 0, evidence: { editor: 'nonzero-recovered' } };
  }, undefined, 'nonzero'));

  evidence.push(runScenario('editor-signal', executable, packageRoot, ({ session, deadline }) => {
    beginEditorLaunch(session, deadline);
    waitForCurrentText(session, 'Editor terminated by SIGTERM', deadline);
    assertAlternate(session, '1');
    sendLiteral(session, 'q');
    return { expectedStatus: 0, evidence: { editor: 'signal-recovered' } };
  }, undefined, 'signal'));

  evidence.push(runScenario('editor-spawn-failure', executable, packageRoot, ({ session, deadline }) => {
    beginEditorLaunch(session, deadline);
    waitForCurrentText(session, 'Could not find editor executable', deadline);
    assertAlternate(session, '1');
    sendLiteral(session, 'q');
    return { expectedStatus: 0, evidence: { editor: 'spawn-failure-recovered' } };
  }, undefined, 'missing'));

  evidence.push(runScenario('idle-ctrl-c', executable, packageRoot, ({ session, deadline }) => {
    waitForCurrentText(session, 'Status: Ready', deadline);
    assertAlternate(session, '1');
    sendKey(session, 'C-c');
    return { expectedStatus: 130 };
  }));

  evidence.push(runScenario('fatal-render', executable, packageRoot, ({ session, deadline, marker }) => {
    waitForCurrentText(session, 'Status: Ready', deadline);
    assertAlternate(session, '1');
    const fixturePid = readFixturePid(marker, deadline, session);
    sendLiteral(session, '4');
    return {
      expectedStatus: 1,
      expectedStderr: 'error: fatal renderer fixture\n',
      fixturePid,
      evidence: { inkFatalRender: true }
    };
  }, 'fatal-render'));

  evidence.push(runScenario('unicode-cell-width', executable, packageRoot, ({ session, deadline, marker }) => {
    waitForCurrentText(session, 'Status: Ready', deadline);
    assertAlternate(session, '1');
    const fixturePid = readFixturePid(marker, deadline, session);
    waitForCurrentText(session, '路径', deadline);
    assertUnicodeCellFrame(session, 80);
    actAndWaitForCurrentText(session, () => resize(session, 60, 16), '路径', deadline);
    assertUnicodeCellFrame(session, 60);
    sendLiteral(session, 'q');
    return {
      expectedStatus: 0,
      fixturePid,
      evidence: {
        fixtureClasses: ['CJK', 'combining', 'emoji-ZWJ', 'ANSI-SGR', 'long-unbroken-path'],
        sizes: ['80x24', '60x16']
      }
    };
  }, 'unicode-width'));

  for (let attempt = 1; attempt <= gracefulRepeatCount; attempt += 1) {
    const name = attempt === 1 ? 'in-flight-graceful' : `in-flight-graceful-repeat-${attempt}`;
    evidence.push(runScenario(name, executable, packageRoot, ({ session, deadline, marker }) => {
      waitForCurrentText(session, 'Status: Ready', deadline);
      assertAlternate(session, '1');
      beginBlockingMutation(session, deadline);
      waitForMarker(`${marker}.mutation-started`, 'mutation-started\n', deadline, session);
      actAndWaitForCurrentText(session, () => sendKey(session, 'C-c'), 'waiting for the operation', deadline);
      waitForMarker(`${marker}.exit-requested-code`, '130\n', deadline, session);
      const pid = readFixturePid(marker, deadline, session);
      publishMarker(`${marker}.complete-mutation`, 'complete-mutation\n');
      waitForMarker(`${marker}.completion-signaled`, 'completion-signaled\n', deadline, session);
      waitForMarker(`${marker}.mutation-resolved`, 'mutation-resolved\n', deadline, session);
      waitForMarker(`${marker}.on-exit-code`, '130\n', deadline, session);
      waitForMarker(`${marker}.tui-exit-code`, '130\n', deadline, session);
      return {
        expectedStatus: 130,
        fixturePid: pid,
        forced: false,
        evidence: { gracefulHandshake: ['mutation-started', 'exit-requested-code-130', 'completion-signaled', 'mutation-resolved', 'on-exit-code-130', 'tui-exit-code-130'] }
      };
    }, 'graceful'));
  }

  evidence.push(runScenario('in-flight-forced', executable, packageRoot, ({ session, deadline, marker }) => {
    waitForCurrentText(session, 'Status: Ready', deadline);
    assertAlternate(session, '1');
    const fixturePid = readFixturePid(marker, deadline, session);
    beginBlockingMutation(session, deadline);
    actAndWaitForCurrentText(session, () => sendKey(session, 'C-c'), 'waiting for the operation', deadline);
    sendKey(session, 'C-c');
    return { expectedStatus: 130, fixturePid, forced: true };
  }, 'forced'));

  for (const item of evidence) process.stdout.write(`${JSON.stringify(item)}\n`);
} finally {
  cleanup();
}

function runScenario(name, executable, packageRoot, drive, fixtureMode, editorMode) {
  const scenarioRoot = join(temporaryRoot, `scenario-${name}`);
  const home = join(scenarioRoot, 'bazframe-home');
  const provider = join(scenarioRoot, 'provider');
  const piAgent = join(scenarioRoot, 'pi-agent');
  const receipt = join(scenarioRoot, 'receipt.txt');
  const receiptTemporary = join(scenarioRoot, 'receipt.tmp');
  const stderrPath = join(scenarioRoot, 'stderr.txt');
  const marker = join(scenarioRoot, 'fixture.pid');
  mkdirSync(scenarioRoot, { recursive: true });
  copyState(stateRoot, home, provider);
  mkdirSync(piAgent, { recursive: true });
  let editorExecutable;
  if (editorMode === 'missing') {
    editorExecutable = join(scenarioRoot, 'missing-editor');
  } else if (editorMode !== undefined) {
    editorExecutable = join(scenarioRoot, 'editor');
    const editorLines = [
      '#!/bin/sh',
      `printf '%s\\n' "$$" >${shellQuote(`${marker}.editor-pid`)}`,
      ...(editorMode === 'blocking-success'
        ? [
            `stty -a >${shellQuote(`${marker}.editor-terminal`)}`,
            `printf 'started\\n' >${shellQuote(`${marker}.editor-started`)}`,
            `while [ ! -f ${shellQuote(`${marker}.editor-release`)} ]; do sleep 0.02; done`,
            `printf '\\nedited by terminal fixture\\n' >>"$1"`,
            'exit 0'
          ]
        : editorMode === 'interruptible'
          ? [
              `trap ${shellQuote(`printf 'interrupted\\n' >${shellQuote(`${marker}.editor-interrupted`)}; exit 130`)} INT`,
              `printf 'started\n' >${shellQuote(`${marker}.editor-started`)}`,
              'while :; do sleep 1; done'
            ]
          : editorMode === 'nonzero'
            ? ['exit 7']
            : ['kill -TERM "$$"', 'sleep 1']),
      ''
    ];
    writeFileSync(editorExecutable, editorLines.join('\n'), { mode: 0o700 });
  }
  const command = fixtureMode === undefined
    ? shellQuote(executable) + ' tui'
    : [
        shellQuote(process.execPath),
        shellQuote(join(projectRoot, 'test/fixtures/tui-blocking-mutation.mjs')),
        shellQuote(packageRoot),
        shellQuote(marker),
        shellQuote(fixtureMode)
      ].join(' ');
  const environment = [
    `HOME=${shellQuote(join(scenarioRoot, 'user-home'))}`,
    `BAZFRAME_HOME=${shellQuote(home)}`,
    `PI_CODING_AGENT_DIR=${shellQuote(piAgent)}`,
    'NO_COLOR=1',
    'TERM=xterm-256color',
    ...(editorExecutable === undefined ? [] : [`VISUAL=${shellQuote(editorExecutable)}`])
  ].join(' ');
  const wrapped = [
    '#!/bin/sh',
    'before=$(stty -g)',
    "trap ':' INT",
    `env ${environment} ${command} 2>${shellQuote(stderrPath)}`,
    'exit_code=$?',
    'after=$(stty -g)',
    `printf '%s\\n%s\\n%s\\n' "$exit_code" "$before" "$after" >${shellQuote(receiptTemporary)}`,
    `mv ${shellQuote(receiptTemporary)} ${shellQuote(receipt)}`,
    'exit "$exit_code"',
    ''
  ].join('\n');
  const wrapperPath = join(scenarioRoot, 'run.sh');
  writeFileSync(wrapperPath, wrapped, { mode: 0o700 });

  const socket = `bazframe-${process.pid}-${randomUUID()}`;
  activeSocket = socket;
  const session = 'validation';
  tmux(socket, ['new-session', '-d', '-x', '80', '-y', '24', '-s', session]);
  tmux(socket, ['set-option', '-t', session, 'remain-on-exit', 'on']);
  sendLiteralWithSocket(socket, session, `sh ${shellQuote(wrapperPath)}`);
  sendKeyWithSocket(socket, session, 'Enter');
  const deadline = Date.now() + SCENARIO_DEADLINE_MS;
  let result;
  let primaryError;
  let cleanupError;
  try {
    const details = drive({ session, deadline, home, marker });
    waitForFile(receipt, deadline, session);
    const [statusText, before, after] = readFileSync(receipt, 'utf8').trimEnd().split('\n');
    const status = Number(statusText);
    if (status !== details.expectedStatus) throw scenarioError(session, `${name} exited ${status}, expected ${details.expectedStatus}`);
    if (before !== after) throw scenarioError(session, `${name} changed stty state (${before} -> ${after})`);
    assertAlternate(session, '0');
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
    if (!stderr.includes('\u001B[?25h')) throw scenarioError(session, `${name} omitted cursor restoration`);
    const plainStderr = stderr.replaceAll('\u001B[?25h', '');
    if (details.forced === true) {
      const expected = 'warning: forced exit; the in-flight operation outcome may be unknown.\n';
      if (plainStderr !== expected) throw scenarioError(session, `${name} stderr differed: ${JSON.stringify(stderr)}`);
    } else {
      const expected = details.expectedStderr ?? '';
      if (plainStderr !== expected) throw scenarioError(session, `${name} stderr differed: ${JSON.stringify(stderr)}`);
    }
    if (details.fixturePid !== undefined && processExists(details.fixturePid)) throw scenarioError(session, `${name} fixture PID survived exit`);
    result = {
      scenario: name,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      tmux: execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim(),
      transport: 'local-installed-tarball-tmux',
      exitCode: status,
      terminalRestored: true,
      cleanup: 'owned-server-and-temporary-root',
      ...(details.evidence ?? {})
    };
  } catch (error) {
    primaryError = error;
  } finally {
    killServer(socket);
    activeSocket = undefined;
    if (serverExists(socket)) cleanupError = new Error(`Owned tmux server ${socket} survived cleanup.`);
    else if (ownedProcessExists(scenarioRoot)) cleanupError = new Error(`A process referencing ${scenarioRoot} survived cleanup.`);
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}

function beginEditorLaunch(session, deadline) {
  waitForCurrentText(session, 'Status: Ready', deadline);
  assertAlternate(session, '1');
  sendLiteral(session, '2');
  actAndWaitForCurrentText(session, () => sendKey(session, 'Enter'), 'Available skills', deadline);
  sendLiteral(session, 'e');
}

function beginBlockingMutation(session, deadline) {
  sendLiteral(session, '2');
  actAndWaitForCurrentText(session, () => sendKey(session, 'Enter'), 'Available skills', deadline);
  actAndWaitForCurrentText(session, () => sendKey(session, 'Tab'), '┃Available skills', deadline);
  actAndWaitForCurrentText(session, () => sendLiteral(session, 'a'), 'Add membership...', deadline);
}

function prepareState(root) {
  mkdirSync(join(root, 'home/profiles/focused/skills'), { recursive: true });
  mkdirSync(join(root, 'provider/demo-skill'), { recursive: true });
  writeFileSync(join(root, 'home/profiles/focused/AGENTS.md'), 'focused\n');
  writeFileSync(join(root, 'home/active-profile'), 'focused\n');
  writeFileSync(join(root, 'provider/demo-skill/SKILL.md'), '---\nname: demo-skill\ndescription: Terminal validation fixture.\n---\n');
}

function copyState(root, home, provider) {
  mkdirSync(resolve(home, '..'), { recursive: true });
  execFileSync('cp', ['-R', join(root, 'home'), home]);
  execFileSync('cp', ['-R', join(root, 'provider'), provider]);
  mkdirSync(join(home, 'skills'), { recursive: true });
  symlinkSync(realpathSync(join(provider, 'demo-skill')), join(home, 'skills', 'demo-skill'), 'dir');
}

function capture(session) {
  return tmux(activeSocket, ['capture-pane', '-p', '-S', '-', '-t', `${session}:0.0`]);
}
function captureCurrent(session) {
  return tmux(activeSocket, ['capture-pane', '-p', '-t', `${session}:0.0`]);
}
function assertTopAligned(session) {
  const rows = captureCurrent(session).split('\n');
  const leadingBlankRows = rows.findIndex((row) => row.length > 0);
  const firstContentRow = rows[Math.max(0, leadingBlankRows)] ?? '';
  if (leadingBlankRows !== 0 || !/^[+┏]/u.test(firstContentRow)) {
    throw scenarioError(session, `TUI shell is not on row 0 after vertical resize (leading blank rows: ${leadingBlankRows}): ${JSON.stringify(firstContentRow)}`);
  }
  return leadingBlankRows;
}
function captureCurrentEscaped(session) {
  return tmux(activeSocket, ['capture-pane', '-p', '-e', '-t', `${session}:0.0`]);
}

function assertUnicodeCellFrame(session, columns) {
  const output = captureCurrent(session);
  const lines = output.split('\n');
  const sourceLines = lines.filter((line) => line.includes('路径'));
  const tokens = ['路径', 'Cafe\u0301', '👩‍💻', 'ANSI'];
  const sourceRow = sourceLines.find((line) => tokens.every((token) => line.includes(token)));
  if (sourceRow === undefined) throw scenarioError(session, `found no complete Unicode source row among ${sourceLines.length} rows at ${columns} columns`);
  let previousIndex = -1;
  for (const token of tokens) {
    const index = sourceRow.indexOf(token);
    if (index <= previousIndex) throw scenarioError(session, `Unicode source row omitted or reordered ${JSON.stringify(token)} at ${columns} columns`);
    previousIndex = index;
  }
  if (!sourceRow.includes('…')) throw scenarioError(session, `Unicode source row omitted truncation at ${columns} columns`);
  if (output.includes('TAIL-SENTINEL-9F4C')) throw scenarioError(session, `Unicode tail sentinel spilled at ${columns} columns`);
  const sourceWidth = stringWidth(sourceRow);
  if (sourceWidth !== columns) throw scenarioError(session, `Unicode source row width was ${sourceWidth}, expected ${columns}`);
  for (const [index, line] of lines.entries()) {
    const width = stringWidth(line);
    if (width > columns) throw scenarioError(session, `row ${index + 1} used ${width} cells at ${columns} columns`);
  }
  const escapedSourceRows = captureCurrentEscaped(session).split('\n').filter((line) => line.includes('路径'));
  const escapedSourceRow = escapedSourceRows.find((line) => tokens.every((token) => line.includes(token)));
  if (escapedSourceRow === undefined
    || !escapedSourceRow.includes('\u001B[')
    || !escapedSourceRow.includes('m')) {
    throw scenarioError(session, `escaped Unicode source row omitted SGR at ${columns} columns`);
  }
}

function waitForCurrentText(session, text, deadline) {
  while (Date.now() < deadline) {
    const output = captureCurrent(session);
    if (output.includes(text)) return output;
  }
  throw scenarioError(session, `Timed out waiting for current pane text ${JSON.stringify(text)}`);
}
function actAndWaitForCurrentText(session, action, text, deadline) {
  const before = captureCurrent(session);
  action();
  while (Date.now() < deadline) {
    const output = captureCurrent(session);
    if (output !== before && output.includes(text)) return output;
  }
  throw scenarioError(session, `Timed out waiting for post-action current pane text ${JSON.stringify(text)}`);
}

function waitForFile(path, deadline, session) {
  while (Date.now() < deadline) if (existsSync(path)) return;
  throw scenarioError(session, `Timed out waiting for file ${path}`);
}
function waitForMarker(path, expected, deadline, session) {
  waitForFile(path, deadline, session);
  const actual = readFileSync(path, 'utf8');
  if (actual !== expected) {
    throw scenarioError(session, `Marker ${path} contained ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
function publishMarker(path, value) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, value, { flag: 'wx', mode: 0o600 });
  renameSync(temporaryPath, path);
}
function readFixturePid(marker, deadline, session) {
  waitForFile(marker, deadline, session);
  const value = readFileSync(marker, 'utf8');
  if (!/^[1-9]\d*\n$/.test(value)) {
    throw scenarioError(session, `Fixture PID marker contained ${JSON.stringify(value)}`);
  }
  return Number(value.trim());
}

function resize(session, columns, rows) {
  tmux(activeSocket, ['resize-window', '-x', String(columns), '-y', String(rows), '-t', session]);
}
function sendLiteral(session, value) { sendLiteralWithSocket(activeSocket, session, value); }
function sendKey(session, value) { sendKeyWithSocket(activeSocket, session, value); }
function sendLiteralWithSocket(socket, session, value) { tmux(socket, ['send-keys', '-t', `${session}:0.0`, '-l', value]); }
function sendKeyWithSocket(socket, session, value) { tmux(socket, ['send-keys', '-t', `${session}:0.0`, value]); }
function assertAlternate(session, expected) {
  const actual = tmux(activeSocket, ['display-message', '-p', '-t', `${session}:0.0`, '#{alternate_on}']).trim();
  if (actual !== expected) throw scenarioError(session, `alternate_on=${actual}, expected ${expected}`);
}
function scenarioError(session, message) { return new Error(`${message}\nPane:\n${capture(session)}`); }
function tmux(socket, args) { return execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' }); }
function killServer(socket) { if (serverExists(socket)) spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'kill-server']); }
function serverExists(socket) { return spawnSync('tmux', ['-L', socket, '-f', '/dev/null', 'has-session'], { stdio: 'ignore' }).status === 0; }
function processExists(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function ownedProcessExists(token) {
  const rows = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout ?? '';
  return rows.split('\n').some((row) => row.includes(token) && !row.includes('ps -axo'));
}
function requireCommand(command) {
  if (spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`]).status !== 0) throw new Error(`test:tui-terminal:local requires ${command} on PATH.`);
}
function cleanup() {
  if (activeSocket !== undefined) killServer(activeSocket);
  if (tarball !== undefined && existsSync(tarball)) rmSync(tarball, { force: true });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
