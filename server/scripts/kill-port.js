#!/usr/bin/env node
const { spawnSync } = require('child_process');

const port = Number(process.argv[2] || process.env.PORT || 2567);

function killPort(p) {
  try {
    if (process.platform === 'win32') {
      const psArgs = [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `$conns=Get-NetTCPConnection -State Listen -LocalPort ${p} -ErrorAction SilentlyContinue; if($conns){$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique; foreach($targetPid in $pids){ try { Stop-Process -Id $targetPid -Force -ErrorAction Stop } catch {} } }`,
      ];
      spawnSync('powershell', psArgs, { stdio: 'inherit' });
    } else {
      const cmd = `bash -lc 'if command -v lsof >/dev/null 2>&1; then p=$(lsof -ti tcp:${p}); [ -n "$p" ] && kill -9 $p || true; elif command -v fuser >/dev/null 2>&1; then fuser -k ${p}/tcp || true; fi'`;
      spawnSync(cmd, { stdio: 'inherit', shell: true });
    }
  } catch (_) { /* ignore */ }
}

killPort(port);
console.log(`[kill-port] Ensured port ${port} is free.`);

