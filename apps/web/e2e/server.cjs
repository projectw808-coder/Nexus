/* eslint-disable */
/**
 * Playwright's web server: seed the e2e database, then run `next start` as a child this script
 * owns. Before starting it frees the port — on Windows two Node processes can bind the same
 * port (SO_REUSEADDR), so a server orphaned by an earlier run would silently share traffic
 * with the new one. Killing this script kills the server: no chain of shells in between.
 */
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.E2E_PORT ?? 3200);
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

function pidsOnPort() {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const pids = new Set();
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === 'TCP' && cols[1]?.endsWith(`:${PORT}`) && cols[3] === 'LISTENING' && cols[4])
        pids.add(Number(cols[4]));
    }
    return [...pids];
  }
  const out =
    spawnSync('lsof', ['-t', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean).map(Number);
}

function freePort() {
  for (const pid of pidsOnPort()) {
    if (pid === process.pid) continue;
    console.warn(`e2e server: port ${PORT} is held by pid ${pid}; stopping it`);
    if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  }
}

freePort();
execFileSync(process.execPath, [require.resolve('tsx/cli'), path.join(__dirname, 'seed.ts')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

const next = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)],
  { cwd: ROOT, stdio: 'inherit', env: process.env },
);
const stop = () => {
  if (next.exitCode === null) {
    if (isWin) spawnSync('taskkill', ['/PID', String(next.pid), '/T', '/F'], { stdio: 'ignore' });
    else next.kill('SIGTERM');
  }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => {
    stop();
    process.exit(0);
  });
process.on('exit', stop);
next.on('exit', (code) => process.exit(code ?? 0));
