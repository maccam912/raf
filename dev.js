const { spawn, spawnSync } = require('child_process');

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const ps = `powershell -NoLogo -NoProfile -Command "` +
        `$conns=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue; ` +
        `if($conns){$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique; ` +
        `foreach($targetPid in $pids){ try { Stop-Process -Id $targetPid -Force -ErrorAction Stop } catch {} } }"`;
      spawnSync(ps, { stdio: 'inherit', shell: true });
    } else {
      const sh = `bash -lc 'if command -v lsof >/dev/null 2>&1; then ` +
        `p=$(lsof -ti tcp:${port}); [ -n "$p" ] && kill -9 $p || true; ` +
        `elif command -v fuser >/dev/null 2>&1; then fuser -k ${port}/tcp || true; fi'`;
      spawnSync(sh, { stdio: 'inherit', shell: true });
    }
  } catch (_) { /* ignore */ }
}

function run(scriptCwd, name) {
  // Use shell to be robust across Windows shells (.cmd) and *nix
  const child = spawn('npm', ['run', 'dev'], {
    cwd: scriptCwd,
    stdio: 'inherit',
    shell: true,
  });
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    // If one process exits, shut down the other and then exit.
    shutdown();
  });
  return child;
}

let procs = [];
function shutdown() {
  procs.forEach((p) => {
    if (!p.killed) {
      try { p.kill('SIGINT'); } catch (_) {}
    }
  });
  // Small delay to let children exit cleanly
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Starting server and client...');
// Ensure Colyseus port is free before starting
killPort(2567);
procs = [
  run('server', 'server'),
  run('client', 'client'),
];
