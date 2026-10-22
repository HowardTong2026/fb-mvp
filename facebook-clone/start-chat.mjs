/**
 * start-chat.mjs — one command to bring the whole NPC chat stack up.
 *
 *   node start-chat.mjs
 *
 * 1. stops any previous bridge / tunnel
 * 2. starts chat-bridge.mjs on 127.0.0.1:8788
 * 3. starts a cloudflared quick tunnel and grabs the public URL
 * 4. writes that URL into wrangler.toml (CHAT_BRIDGE_URL)
 * 5. re-deploys the Worker so the public site can reach the bridge
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, 'chat-bridge.config.json'), 'utf8'));
const CF_CFG = 'C:/Users/user/AppData/Roaming/xdg.config/cloudflare/config/default.json';
const CF = JSON.parse(readFileSync(CF_CFG, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ---------- 1. kill old stuff ---------- */
log('[1/5] stopping previous bridge / tunnel ...');
for (const name of ['chat-bridge.mjs', 'cloudflared']) {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe' OR Name='cloudflared.exe'\\" | Where-Object { $_.CommandLine -like '*${name}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    );
  } catch {}
}
try {
  execSync(`powershell -NoProfile -Command "Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force"`, { stdio: 'ignore' });
} catch {}
await sleep(1500);

/* ---------- 2. bridge ---------- */
log('[2/5] starting chat bridge ...');
const bridgeOut = [];
const bridge = spawn('node', [join(HERE, 'chat-bridge.mjs')], {
  cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'],
});
bridge.stdout.on('data', (d) => bridgeOut.push(d.toString()));
bridge.stderr.on('data', (d) => bridgeOut.push(d.toString()));
await sleep(2000);

const health = await fetch(`http://127.0.0.1:${CFG.port}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  log('  ✗ bridge failed to start:');
  log(bridgeOut.join(''));
  process.exit(1);
}
log(`  ✓ bridge up — agent=${health.agent} model=${health.model}`);

/* ---------- 3. tunnel ---------- */
log('[3/5] starting cloudflared quick tunnel ...');

// cloudflared is an npm global shim -> use the .cmd wrapper explicitly
const CLOUDFLARED = [
  'C:/Users/user/AppData/Roaming/npm/cloudflared.cmd',
  'C:/Users/user/AppData/Roaming/npm/cloudflared',
].find((p) => { try { return readFileSync(p, 'utf8').length >= 0; } catch { return false; } })
  || 'cloudflared.cmd';

let tunnelOut = '';
const tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${CFG.port}`, '--no-autoupdate'], {
  cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'], shell: true,
});
tunnel.stdout.on('data', (d) => { tunnelOut += d.toString(); });
tunnel.stderr.on('data', (d) => { tunnelOut += d.toString(); });

let tunnelUrl = null;
for (let i = 0; i < 40 && !tunnelUrl; i++) {
  await sleep(1000);
  const m = tunnelOut.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m) tunnelUrl = m[0];
}
if (!tunnelUrl) {
  log('  ✗ tunnel did not come up:');
  log(tunnelOut.slice(-1500));
  process.exit(1);
}
log(`  ✓ tunnel: ${tunnelUrl}`);

// sanity check through the tunnel (it takes a few seconds to become routable)
let viaTunnel = null;
for (let i = 0; i < 20 && !viaTunnel?.ok; i++) {
  await sleep(2000);
  viaTunnel = await fetch(`${tunnelUrl}/health`).then((r) => r.json()).catch(() => null);
}
if (!viaTunnel?.ok) {
  log('  ✗ tunnel health check failed');
  log(tunnelOut.slice(-1200));
  process.exit(1);
}
log('  ✓ tunnel health check passed');

/* ---------- 4. update wrangler.toml ---------- */
log('[4/5] updating wrangler.toml ...');
const tomlPath = join(HERE, 'wrangler.toml');
let toml = readFileSync(tomlPath, 'utf8');
if (/^CHAT_BRIDGE_URL = .*$/m.test(toml)) {
  toml = toml.replace(/^CHAT_BRIDGE_URL = .*$/m, `CHAT_BRIDGE_URL = "${tunnelUrl}"`);
} else {
  toml += `\nCHAT_BRIDGE_URL = "${tunnelUrl}"\n`;
}
writeFileSync(tomlPath, toml, 'utf8');
log(`  ✓ CHAT_BRIDGE_URL = ${tunnelUrl}`);

/* ---------- 5. deploy ---------- */
log('[5/5] deploying worker ...');
// the cf CLI OAuth token expires hourly — refresh it first
try {
  execSync('cf auth whoami', { stdio: 'ignore' });
  CF.oauth_token = JSON.parse(readFileSync(CF_CFG, 'utf8')).oauth_token;
  log('  ✓ refreshed Cloudflare token');
} catch {
  log('  ! could not refresh Cloudflare token (deploy may fail)');
}

const dep = spawn('npx wrangler deploy', {
  cwd: HERE, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLOUDFLARE_API_TOKEN: CF.oauth_token },
});
let depOut = '';
dep.stdout.on('data', (d) => (depOut += d));
dep.stderr.on('data', (d) => (depOut += d));
await new Promise((r) => dep.on('close', r));
log(depOut.trim().split('\n').slice(-5).join('\n'));

const deployed = /https:\/\/\S*workers\.dev/.test(depOut);
if (!deployed) {
  log('\n  ✗ deploy FAILED — see the output above');
  log('  The bridge and tunnel are still running. Re-run this script to retry.');
  process.exit(1);
}

log('\n=========================================');
log('  Chat stack is UP');
log(`  Worker   : https://facebook-clone.howardtong2026.workers.dev`);
log(`  Bridge   : http://127.0.0.1:${CFG.port}`);
log(`  Tunnel   : ${tunnelUrl}`);
log(`  NPC      : ${health.agent} (${health.model})`);
log('  Keep this window open. Ctrl+C to stop.');
log('=========================================');

// keep the process alive
process.on('SIGINT', () => { bridge.kill(); tunnel.kill(); process.exit(0); });
await new Promise(() => {});
