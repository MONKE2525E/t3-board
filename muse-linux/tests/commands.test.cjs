const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Commands } = require('../src/commands.cjs');

const ROOT = '/tmp/muse-port-d6c9/parity/prefs-commands';
const nodeBin = process.execPath;

async function tempDir(t) {
  await fs.mkdir(ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(ROOT, 'cmd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('wait_timeout');
}

function makeCommands(cwd, permission = async () => true) {
  return new Commands({
    permission,
    resolve: async value => ({ target: value || cwd }),
  });
}

function deadline(ms = 8000) {
  return Date.now() + ms;
}

function argv(list) {
  return JSON.stringify(list);
}

test('run accepts a JSON argv array, approved cwd, and returns the bounded result shape', async t => {
  const cwd = await tempDir(t);
  const seen = [];
  const commands = makeCommands(cwd, async (command, until) => {
    seen.push(command, until);
    return true;
  });
  const until = deadline();
  const result = await commands.run({ argv: argv([nodeBin, '-e', 'process.stdout.write("ok"); process.stderr.write("e");']), cwd }, until);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, 'e');
  assert.equal(result.timed_out, false);
  assert.equal(result.truncated, false);
  assert.equal(Object.hasOwn(result, 'exit_code'), true);
  assert.equal(Object.hasOwn(result, 'stdout'), true);
  assert.equal(Object.hasOwn(result, 'stderr'), true);
  assert.equal(Object.hasOwn(result, 'timed_out'), true);
  assert.equal(Object.hasOwn(result, 'truncated'), true);
  assert.equal(seen[0], argv([nodeBin, '-e', 'process.stdout.write("ok"); process.stderr.write("e");']));
  assert.equal(seen[1], until);
});

test('argv must be a JSON array; no shell wrapper is added', async t => {
  const cwd = await tempDir(t);
  const commands = makeCommands(cwd);
  await assert.rejects(commands.run({ argv: 'node -e 1', cwd }, deadline()), /argv_required/);
  await assert.rejects(commands.run({ argv: argv([]), cwd }, deadline()), /invalid_argv/);
  await assert.rejects(commands.run({ argv: argv([nodeBin, 'x\0y']), cwd }, deadline()), /invalid_argv/);
  await assert.rejects(commands.run({ argv: argv(['']), cwd }, deadline()), /invalid_argv/);
  await assert.rejects(commands.run({ cwd }, deadline()), /argv_required/);
});

test('permission denial and expired deadlines never spawn', async t => {
  const cwd = await tempDir(t);
  const marker = path.join(cwd, 'spawned');
  const denied = makeCommands(cwd, async () => false);
  await assert.rejects(denied.run({
    argv: argv([nodeBin, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "yes")`]),
    cwd,
  }, deadline()), /command_permission_denied/);
  await assert.rejects(fs.access(marker));
  const expired = makeCommands(cwd);
  await assert.rejects(expired.run({ argv: argv([nodeBin, '-e', '0']), cwd }, Date.now() - 1), /request_expired/);
});

test('commandPolicy allow runs a real shell when the argv names one', async t => {
  const cwd = await tempDir(t);
  const commands = makeCommands(cwd);
  const result = await commands.run({ argv: argv(['bash', '-lc', 'printf shell-ok']), cwd, timeout_ms: 4000 }, deadline());
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'shell-ok');
});

test('approved commands are not path-sandboxed; they may read outside cwd', async t => {
  const cwd = await tempDir(t);
  const outside = path.join(ROOT, `outside-${process.pid}-${Date.now()}`);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.writeFile(outside, 'outside-ok', { mode: 0o600 });
  const commands = makeCommands(cwd);
  const result = await commands.run({
    argv: argv([nodeBin, '-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', outside]),
    cwd,
  }, deadline());
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'outside-ok');
});

test('timeout bounds the one-shot run and stop kills the process group including grandchildren', async t => {
  const cwd = await tempDir(t);
  const commands = makeCommands(cwd);
  const timed = await commands.run({
    argv: argv([nodeBin, '-e', 'setTimeout(() => {}, 60000)']),
    cwd,
    timeout_ms: 200,
  }, deadline());
  assert.equal(timed.timed_out, true);
  assert.equal(commands.active, null);

  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    spawn(process.execPath, ['-e', 'const fs=require("fs"); fs.writeFileSync("grandchild.pid", String(process.pid)); setInterval(() => {}, 1000);'], { stdio: "ignore", detached: false });
    fs.writeFileSync("parent.pid", String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const running = commands.run({ argv: argv([nodeBin, '-e', script]), cwd, timeout_ms: 15000 }, deadline(20000));
  const parentPid = Number(await waitUntil(async () => {
    try { return await fs.readFile(path.join(cwd, 'parent.pid'), 'utf8'); } catch { return ''; }
  }));
  const childPid = Number(await waitUntil(async () => {
    try { return await fs.readFile(path.join(cwd, 'grandchild.pid'), 'utf8'); } catch { return ''; }
  }));
  assert.equal(alive(parentPid), true);
  assert.equal(alive(childPid), true);
  commands.stop();
  const result = await running;
  assert.equal(commands.active, null);
  await waitUntil(() => !alive(parentPid) && !alive(childPid));
  assert.equal(alive(parentPid), false);
  assert.equal(alive(childPid), false);
  assert.equal(result.timed_out, false);
});

test('stop and stopActive both terminate only this run, and leftover children die when the parent process exits', async t => {
  const cwd = await tempDir(t);
  const helper = path.join(cwd, 'exit-helper.cjs');
  const commandsPath = require.resolve('../src/commands.cjs');
  await fs.writeFile(helper, `
    const { Commands } = require(${JSON.stringify(commandsPath)});
    const fs = require('node:fs');
    const path = require('node:path');
    const cwd = process.argv[2];
    (async () => {
      const commands = new Commands({ permission: async () => true, resolve: async () => ({ target: cwd }) });
      void commands.run({
        argv: JSON.stringify([process.execPath, '-e', 'const fs=require("fs"); fs.writeFileSync("alive.pid", String(process.pid)); setInterval(() => {}, 1000);']),
        cwd,
      }, Date.now() + 20000);
      const start = Date.now();
      while (!fs.existsSync(path.join(cwd, 'alive.pid'))) {
        if (Date.now() - start > 5000) process.exit(2);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      process.exit(0);
    })().catch(() => process.exit(2));
  `);
  await new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [helper, cwd], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`helper_exit_${code}`)));
  });
  const pid = Number(await fs.readFile(path.join(cwd, 'alive.pid'), 'utf8'));
  await waitUntil(() => !alive(pid));
  assert.equal(alive(pid), false);

  const commands = makeCommands(cwd);
  const running = commands.run({ argv: argv([nodeBin, '-e', 'setInterval(() => {}, 1000)']), cwd, timeout_ms: 15000 }, deadline(20000));
  await new Promise(resolve => setTimeout(resolve, 80));
  commands.stopActive();
  const result = await running;
  assert.equal(commands.active, null);
  assert.equal(result.timed_out, false);
});

test('stop during resolve or permission invalidates that generation and never spawns', async t => {
  const cwd = await tempDir(t);
  const marker = path.join(cwd, 'spawned');
  const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, "yes")`;
  let releasePermission;
  const permissionGate = new Promise(resolve => { releasePermission = resolve; });
  const permission = makeCommands(cwd, async () => {
    await permissionGate;
    return true;
  });
  const pendingPermission = permission.run({ argv: argv([nodeBin, '-e', script]), cwd }, deadline());
  await new Promise(resolve => setTimeout(resolve, 30));
  permission.stop();
  releasePermission();
  await assert.rejects(pendingPermission, /command_stopped/);
  await assert.rejects(fs.access(marker));

  let releaseResolve;
  const resolveGate = new Promise(resolve => { releaseResolve = resolve; });
  const resolving = new Commands({
    permission: async () => true,
    resolve: async value => {
      await resolveGate;
      return { target: value || cwd };
    },
  });
  const pendingResolve = resolving.run({ argv: argv([nodeBin, '-e', script]), cwd }, deadline());
  await new Promise(resolve => setTimeout(resolve, 30));
  resolving.stop();
  releaseResolve();
  await assert.rejects(pendingResolve, /command_stopped/);
  await assert.rejects(fs.access(marker));
});

test('close after exit drains stdout that was still queued', async t => {
  const cwd = await tempDir(t);
  const commands = makeCommands(cwd);
  const result = await commands.run({
    argv: argv([nodeBin, '-e', 'for (let i = 0; i < 200; i++) process.stdout.write("line-"+i+"\\n"); process.stdout.write("drain-end\\n");']),
    cwd,
  }, deadline());
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /^line-0\n/);
  assert.match(result.stdout, /\ndrain-end\n$/);
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 201);
});

test('output is truncated, environment omits credential variables, and stdout is returned only in the result', async t => {
  const cwd = await tempDir(t);
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.OPENAI_API_KEY = 'sk-test-not-for-output';
  process.env.GITHUB_TOKEN = 'ghs_test-not-for-output';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-test-not-for-output';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const commands = makeCommands(cwd);
  const envResult = await commands.run({
    argv: argv([nodeBin, '-e', 'process.stdout.write(Object.keys(process.env).sort().join(","))']),
    cwd,
  }, deadline());
  const keys = new Set(envResult.stdout.split(',').filter(Boolean));
  assert.equal(keys.has('OPENAI_API_KEY'), false);
  assert.equal(keys.has('GITHUB_TOKEN'), false);
  assert.equal(keys.has('AWS_SECRET_ACCESS_KEY'), false);
  assert.equal(keys.has('ELECTRON_RUN_AS_NODE'), false);
  assert.equal(keys.has('PATH'), true);
  const big = await commands.run({
    argv: argv([nodeBin, '-e', 'process.stdout.write("a".repeat(70000))']),
    cwd,
  }, deadline());
  assert.equal(big.stdout.length, 64000);
  assert.equal(big.truncated, true);
});

test('truncation is reported when the final pipe chunk crosses either text limit', async () => {
  const { EventEmitter } = require('node:events');
  const vm = require('node:vm');
  const source = await fs.readFile(require.resolve('../src/commands.cjs'), 'utf8');
  for (const stream of ['stdout', 'stderr']) {
    for (const chunks of [ [64001], [63999, 2], [64000] ]) {
      const module = { exports: {} };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      vm.runInNewContext(source, {
        module, process, setTimeout, clearTimeout,
        require: id => id === 'node:child_process' ? { spawn: () => child } : require(id),
      });
      const commands = new module.exports.Commands({});
      const pending = commands.spawnRun(['fixture'], '/tmp', 1000);
      for (const size of chunks) child[stream].emit('data', Buffer.alloc(size, 'a'));
      child.emit('exit', 0, null);
      child.emit('close');
      const result = await pending;
      assert.equal(result[stream].length, 64000);
      assert.equal(result.truncated, chunks.reduce((a, b) => a + b, 0) > 64000);
    }
  }
});

test('missing executables fail cleanly and a second run is rejected while one is active', async t => {
  const cwd = await tempDir(t);
  const commands = makeCommands(cwd);
  await assert.rejects(commands.run({ argv: argv([path.join(cwd, 'missing-bin')]), cwd }, deadline()), /executable_not_found/);
  const running = commands.run({ argv: argv([nodeBin, '-e', 'setInterval(() => {}, 1000)']), cwd, timeout_ms: 8000 }, deadline(10000));
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(commands.run({ argv: argv([nodeBin, '-e', '0']), cwd }, deadline()), /busy/);
  commands.stop();
  await running;
});
