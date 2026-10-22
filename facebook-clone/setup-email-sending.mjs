/**
 * setup-email-sending.mjs — turn on Cloudflare Email Sending so the app can
 * email ANY third party (not just the Resend account address).
 *
 * Prerequisites (2 things):
 *  1. An active Cloudflare zone (a domain whose nameservers point at Cloudflare).
 *     Candidates: howardtong.eu.org (waiting on eu.org) or a domain you register.
 *  2. A Cloudflare API token with the "Email Sending: Edit" permission.
 *     Create it at https://dash.cloudflare.com/profile/api-tokens
 *     Save it to:  C:\Users\user\Desktop\AI學習第九課\cf-email-token.txt
 *
 * Usage:
 *   node setup-email-sending.mjs <domain> [test-recipient@example.com]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CWD = 'C:/Users/user/Desktop/AI學習第九課/facebook-clone';
const TOKEN_FILE = 'C:/Users/user/Desktop/AI學習第九課/cf-email-token.txt';
const CFG_CLOUD = 'C:/Users/user/AppData/Roaming/xdg.config/cloudflare/config/default.json';

const DOMAIN = (process.argv[2] || '').trim().toLowerCase();
const TEST_TO = process.argv[3] || '';

if (!DOMAIN) {
  console.error('Usage: node setup-email-sending.mjs <domain> [test-recipient]');
  process.exit(1);
}
if (!existsSync(TOKEN_FILE)) {
  console.error(`Missing ${TOKEN_FILE}`);
  console.error('Create a Cloudflare API token with "Email Sending: Edit" and save it there.');
  process.exit(1);
}
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
const cf = JSON.parse(readFileSync(CFG_CLOUD, 'utf8'));
const ENV = { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN };

function run(cmd, stdin) {
  return new Promise((resolve) => {
    const p = spawn(cmd, { cwd: CWD, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: ENV });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    if (stdin !== undefined) { p.stdin.write(stdin + '\n'); p.stdin.end(); } else p.stdin.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* 1. is the zone active? */
log(`\n=== checking zone ${DOMAIN} ===`);
{
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(DOMAIN)}`,
    { headers: { authorization: `Bearer ${cf.oauth_token}` } },
  );
  const j = await res.json().catch(() => ({}));
  const z = j?.result?.[0];
  if (!z) { log('  ✗ no zone in this account. Register a domain first.'); process.exit(1); }
  log(`  zone ${z.id}  status=${z.status}`);
  if (z.status !== 'active') {
    log(`  ✗ zone is "${z.status}" — nameservers aren't delegated to Cloudflare yet.`);
    log('    Wait for delegation, then re-run this script.');
    process.exit(2);
  }
  log('  ✓ zone is active');
}

/* 2. onboard for Email Sending (auto-adds SPF / DKIM / DMARC / bounce MX) */
log(`\n=== onboarding ${DOMAIN} for Email Sending ===`);
{
  const r = await run(`npx wrangler email sending enable ${DOMAIN}`);
  log(r.out.split('\n').filter((l) => l.trim() && !/open beta|github\.com\/cloudflare/.test(l)).slice(-14).join('\n'));
  if (/ERROR/i.test(r.out) && !/already|success/i.test(r.out)) {
    log('  ✗ onboarding failed');
    process.exit(1);
  }
}

/* 3. show the DNS records (should already be added) */
log(`\n=== DNS records for ${DOMAIN} ===`);
{
  const r = await run(`npx wrangler email sending dns get ${DOMAIN}`);
  log(r.out.split('\n').filter((l) => l.trim() && !/open beta/.test(l)).slice(-24).join('\n'));
}

/* 4. flip the flag + set the sender */
log(`\n=== updating wrangler.toml ===`);
{
  const p = CWD + '/wrangler.toml';
  let toml = readFileSync(p, 'utf8');
  toml = toml.replace(/^EMAIL_SENDING_ACTIVE = .*$/m, 'EMAIL_SENDING_ACTIVE = "true"');
  toml = toml.replace(/^EMAIL_FROM = .*$/m, `EMAIL_FROM = "Facebook Clone <noreply@${DOMAIN}>"`);
  writeFileSync(p, toml, 'utf8');
  log(`  EMAIL_FROM = Facebook Clone <noreply@${DOMAIN}>`);
  log('  EMAIL_SENDING_ACTIVE = true');
}

/* 5. deploy */
log(`\n=== deploying ===`);
{
  const r = await run('npx wrangler deploy');
  log(r.out.split('\n').slice(-6).join('\n'));
}

/* 6. proof: email a third party */
if (TEST_TO) {
  log(`\n=== proof: emailing ${TEST_TO} ===`);
  const res = await fetch('https://facebook-clone.howardtong2026.workers.dev/api/send-verification', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: TEST_TO, name: 'Proof Test' }),
  });
  const j = await res.json().catch(() => ({}));
  log(`  status ${res.status}`);
  log(`  ${JSON.stringify(j).slice(0, 300)}`);
  log(j.ok ? '\n  ✓ SUCCESS — third-party email sent.' : '\n  ✗ failed');
} else {
  log('\nNext: pick any third-party address and test it:');
  log(`  node setup-email-sending.mjs ${DOMAIN} someone@gmail.com`);
}
