/**
 * One-shot setup helper.
 *   node setup-google.mjs <GOOGLE_CLIENT_ID> <GOOGLE_CLIENT_SECRET>
 * or
 *   node setup-google.mjs            -> reads the two values from a file you paste into
 *
 * Sets both as Worker secrets, deploys, then verifies /api/google-login works.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CWD = 'C:/Users/user/Desktop/AI學習第九課/facebook-clone';
const BASE = 'https://facebook-clone.howardtong2026.workers.dev';

// Reuse the token from the `cf` CLI login so we deploy to the real account.
const CF_CFG = 'C:/Users/user/AppData/Roaming/xdg.config/cloudflare/config/default.json';
let ENV = {};
try {
  ENV = { CLOUDFLARE_API_TOKEN: JSON.parse(readFileSync(CF_CFG, 'utf8')).oauth_token };
} catch {
  console.warn('Could not read the cf CLI token - fall back to a `wrangler login` session.');
}

function run(args, stdin) {
  return new Promise((resolve) => {
    const p = spawn('npx', args, { cwd: CWD, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ENV } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    if (stdin !== undefined) { p.stdin.write(stdin + '\n'); p.stdin.end(); }
    else p.stdin.end();
  });
}

let clientId, clientSecret;

if (process.argv[2] && process.argv[3]) {
  clientId = process.argv[2].trim();
  clientSecret = process.argv[3].trim();
} else {
  // read from a local file: first line = client id, second line = secret
  const f = 'C:/Users/user/Desktop/AI學習第九課/google-oauth.txt';
  const lines = readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  clientId = lines[0];
  clientSecret = lines[1];
  writeFileSync(f, 'CONFIGURED\n', 'utf8'); // scrub the raw values from disk
}

if (!clientId || !clientSecret) {
  console.error('Need client id + secret. Put them in C:/Users/user/Desktop/AI學習第九課/google-oauth.txt (line 1 = id, line 2 = secret) and rerun.');
  process.exit(1);
}

console.log('--- setting GOOGLE_CLIENT_ID ---');
let r = await run(['wrangler', 'secret', 'put', 'GOOGLE_CLIENT_ID'], clientId);
console.log(r.out.trim().split('\n').slice(-3).join('\n'));

console.log('\n--- setting GOOGLE_CLIENT_SECRET ---');
r = await run(['wrangler', 'secret', 'put', 'GOOGLE_CLIENT_SECRET'], clientSecret);
console.log(r.out.trim().split('\n').slice(-3).join('\n'));

console.log('\n--- deploying ---');
r = await run(['wrangler', 'deploy']);
console.log(r.out.trim().split('\n').slice(-4).join('\n'));

console.log('\n--- verifying /api/google-login ---');
const res = await fetch(BASE + '/api/google-login');
const j = await res.json().catch(() => ({}));
console.log('status', res.status);
if (j.ok) {
  console.log('  OK — Google sign-in is live.');
  console.log('  authUrl:', String(j.authUrl).slice(0, 130) + '…');
  console.log('  redirectUri:', j.redirectUri);
} else {
  console.log('  ', JSON.stringify(j).slice(0, 300));
}
