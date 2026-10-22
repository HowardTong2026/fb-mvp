/**
 * Facebook-Clone — Cloudflare Worker (plain, no build step)
 *
 * Routes:
 *   GET  /                      -> frontend (static asset)
 *   GET  /api/config            -> which integrations are configured
 *   POST /api/send-verification -> create token, send email via Resend
 *   GET  /api/verify?token=     -> validate token, mark email verified
 *   GET  /api/google-login      -> Google OAuth authorize URL
 *   GET  /api/google-callback   -> exchange code, create user, set session
 *   GET  /api/session           -> current user (from signed cookie)
 *   POST /api/logout            -> clear session cookie
 */

const enc = new TextEncoder();

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** constant-time-ish string compare */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(value, secret) {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** session cookie value = base64url(json).signature */
async function makeSession(payload, secret) {
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${body}.${await sign(body, secret)}`;
}

/** Session cookie flags. `Secure` is added whenever the request is over HTTPS. */
function sessionCookie(sessionValue, request) {
  const secure = (() => {
    try { return new URL(request.url).protocol === "https:"; } catch { return false; }
  })();
  return `fb_session=${sessionValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(request) {
  const secure = (() => {
    try { return new URL(request.url).protocol === "https:"; } catch { return false; }
  })();
  return `fb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

async function readSession(req, secret) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)fb_session=([^;]+)/);
  if (!match) return null;
  const [body, mac] = match[1].split(".");
  if (!body || !mac) return null;
  if (!safeEqual(mac, await sign(body, secret))) return null;
  try {
    return JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Resend                                                              */
/* ------------------------------------------------------------------ */

async function sendEmail(env, { to, subject, html, text }) {
  const resendFrom = env.RESEND_FROM || "";
  const cfFrom = env.EMAIL_FROM || "";
  if (!env.EMAIL && !env.RESEND_API_KEY) {
    return { ok: false, status: 500, error: "No email provider configured (EMAIL binding or RESEND_API_KEY)." };
  }
  if (!cfFrom && !resendFrom) {
    return { ok: false, status: 500, error: "EMAIL_FROM / RESEND_FROM is not configured." };
  }

  // 1. Cloudflare Email Sending (Workers binding) — sends to ANY recipient, no API key.
  //    Only try it once a domain is actually onboarded, otherwise the binding throws
  //    on every send.
  if (env.EMAIL && cfFrom && env.EMAIL_SENDING_ACTIVE === "true") {
    try {
      const res = await env.EMAIL.send({
        to,
        from: cfFrom,
        subject,
        html,
        text: text || stripHtml(html),
      });
      return { ok: true, provider: "cloudflare", id: res?.messageId ?? null, status: 200 };
    } catch (e) {
      if (!env.RESEND_API_KEY) {
        return {
          ok: false,
          provider: "cloudflare",
          status: 500,
          error: `Cloudflare Email Sending failed: ${String(e?.message || e)}`,
        };
      }
      // fall through to Resend
    }
  }

  // 2. Resend fallback — must use RESEND_FROM (the Resend-registered sender)
  if (!env.RESEND_API_KEY) {
    return { ok: false, status: 500, error: "RESEND_API_KEY is not configured." };
  }
  // The shared test sender (onboarding@resend.dev) can only deliver to the
  // address registered on the Resend account. Everyone else needs a real domain.
  const accountEmail = String(env.RESEND_ACCOUNT_EMAIL || "").toLowerCase();
  if (isSharedTestSender(resendFrom) && String(to).toLowerCase() !== accountEmail) {
    return {
      ok: false,
      provider: "resend",
      status: 403,
      error:
        "Resend's shared test sender (onboarding@resend.dev) can only deliver to the account address " +
        `(${accountEmail || "your Resend account email"}). ` +
        "To email other people, onboard a domain for Cloudflare Email Sending — it is free.",
    };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: resendFrom,
      to: [to],
      subject,
      html,
      text: text || stripHtml(html),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: friendlyResendError(data, res.status, resendFrom),
      details: data,
    };
  }
  return { ok: true, provider: "resend", id: data.id, status: res.status };
}

/**
 * True when the sender is a shared/test address that can only deliver to the
 * account owner (Resend's onboarding@resend.dev). Sending to anyone else
 * fails, so we skip rather than burn API calls.
 */
function isSharedTestSender(from) {
  return /@resend\.dev\s*>$/i.test(String(from || ""));
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Turn Resend's terse API errors into something a human can act on. */
function friendlyResendError(data, status, from) {
  const raw = data?.message || data?.name || `Resend returned HTTP ${status}`;
  const msg = String(raw);

  if (/only send emails|restricted/i.test(msg)) {
    return "This Resend key is restricted to sending only — that's fine, but the Worker needs it as a secret named RESEND_API_KEY.";
  }
  if (/only be sent to|testing email|your own email/i.test(msg) || /You can only send testing emails/i.test(msg)) {
    return (
      "Resend only allows sending to your own account email while using the shared onboarding@resend.dev sender. " +
      "To email anyone else, add and verify a domain in Resend, then set RESEND_FROM to an address on that domain " +
      "(e.g. \"Facebook Clone <noreply@yourdomain.com>\") in wrangler.toml and redeploy."
    );
  }
  if (/domain .* is not verified|not verified/i.test(msg)) {
    return "The sender domain isn't verified in Resend yet. Verify it in the Resend dashboard, then set RESEND_FROM to an address on it.";
  }
  if (/invalid api key|unauthorized|401/i.test(msg)) {
    return "Resend rejected the API key. Check RESEND_API_KEY is the send-only key from resend.com/api-keys.";
  }
  if (/rate limit|429/i.test(msg)) {
    return "Resend rate limit reached. Wait a moment and try again.";
  }
  if (/invalid.*from|from.*invalid/i.test(msg)) {
    return `Resend rejected the sender address (RESEND_FROM). Current value: ${from ?? "(unset)"} — it must be a verified domain or onboarding@resend.dev.`;
  }
  return raw;
}

function verificationEmail({ name, url }) {
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr><td style="padding:28px 32px 12px;">
          <div style="font-size:26px;font-weight:800;color:#1877f2;letter-spacing:-.5px;">Facebook</div>
          <div style="font-size:13px;color:#65676b;margin-top:2px;">Clone &mdash; powered by Cloudflare Workers</div>
        </td></tr>
        <tr><td style="padding:12px 32px 0;">
          <h1 style="margin:0 0 12px;font-size:22px;color:#1c1e21;letter-spacing:-.3px;">Welcome${name ? `, ${escapeHtml(name)}` : ""}!</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#65676b;">Confirm your email address to activate your account. This link expires in 24 hours.</p>
        </td></tr>
        <tr><td align="center" style="padding:4px 32px 28px;">
          <a href="${url}" style="display:inline-block;background:#1877f2;color:#fff!important;text-decoration:none;font-size:16px;font-weight:600;padding:14px 28px;border-radius:8px;">Verify email address</a>
        </td></tr>
        <tr><td style="padding:0 32px 28px;">
          <p style="margin:0;font-size:13px;color:#8a8d91;line-height:1.5;">If the button doesn&rsquo;t work, paste this link into your browser:<br>
          <a href="${url}" style="color:#1877f2;word-break:break-all;">${url}</a></p>
        </td></tr>
        <tr><td style="padding:18px 32px;background:#f7f8fa;border-top:1px solid #e4e6eb;">
          <p style="margin:0;font-size:12px;color:#8a8d91;">You didn&rsquo;t request this? No worries &mdash; ignore this email and nothing happens.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `Welcome${name ? ", " + name : ""}!

Confirm your email address to activate your Facebook Clone account.
This link expires in 24 hours.

Verify email address:
${url}

If the link doesn't work, copy the URL above into your browser.

You didn't request this? No worries - ignore this email and nothing happens.`;

  return { html, text };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Strip HTML from user text before storing it.
 * The frontend escapes on render too — this is defence in depth, so a future
 * rendering path can't turn a stored post into XSS.
 */
function sanitizeText(s, maxLen = 2000) {
  return String(s ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")          // any remaining tag
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/on\w+\s*=\s*[^\s>]+/gi, "")
    .slice(0, maxLen)
    .trim();
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

async function handleSendVerification(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Request body must be JSON." }, 400);
  }

  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ ok: false, error: "Enter a valid email address." }, 400);
  }
  if (!env.RESEND_API_KEY && !env.EMAIL) {
    return json({ ok: false, error: "No email provider is configured." }, 500);
  }

  // Guard 1: the caller is already signed in as this address -> never email them again
  const sess = await readSession(request, env.SESSION_SECRET || "dev-secret-change-me");
  if (sess && String(sess.email).toLowerCase() === email) {
    return json({
      ok: true,
      alreadySignedIn: true,
      emailSent: false,
      message: "You're already signed in — no email needed.",
      user: { email: sess.email, name: sess.name },
    });
  }

  // Guard 2: cool-down — don't send a second email for the same address in quick
  // succession (protects against a browser re-submitting the form on refresh)
  const COOLDOWN_MS = 5 * 60_000;
  const prior = env.VERIFY_TOKENS ? await env.VERIFY_TOKENS.get(`user:${email}`, "json") : null;
  if (prior && prior.token && prior.createdAt && Date.now() - prior.createdAt < COOLDOWN_MS) {
    const siteUrl = env.SITE_URL || url.origin;
    const verifyUrl = `${siteUrl}/api/verify?token=${prior.token}&email=${encodeURIComponent(email)}`;
    return json({
      ok: true,
      emailSent: false,
      throttled: true,
      message: "A verification email was just sent. Check your inbox.",
      ...(env.EXPOSE_DEV_TOKEN === "true" ? { devToken: prior.token, devVerifyUrl: verifyUrl } : {}),
    });
  }

  const token = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;

  // Persist the pending user + token (KV id: "user:<email>")
  if (env.VERIFY_TOKENS) {
    await env.VERIFY_TOKENS.put(
      `user:${email}`,
      JSON.stringify({
        userId,
        email,
        name: String(body?.name ?? "").slice(0, 80),
        verified: false,
        token,
        expiresAt,
        createdAt: now,
        provider: "email",
      }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
  }

  const siteUrl = env.SITE_URL || url.origin;
  const verifyUrl = `${siteUrl}/api/verify?token=${token}&email=${encodeURIComponent(email)}`;

  const sent = await sendEmail(env, {
    to: email,
    subject: "Verify your Facebook Clone account",
    ...(() => { const t = verificationEmail({ name: String(body?.name ?? "").slice(0, 80), url: verifyUrl }); return { html: t.html, text: t.text }; })(),
  });

  if (!sent.ok) {
    // In dev mode we still hand back the token so any address can be tested
    // locally, even when the provider can't actually deliver to it.
    if (env.EXPOSE_DEV_TOKEN === "true") {
      return json(
        {
          ok: true,
          emailSent: false,
          devOnly: true,
          error: sent.error,
          message: "Dev mode: the email could not be delivered, but the link is below.",
          devToken: token,
          devVerifyUrl: verifyUrl,
        },
        200,
      );
    }
    return json({ ok: false, error: sent.error, details: sent.details }, sent.status);
  }

  return json({
    ok: true,
    message: "Verification email sent.",
    resendId: sent.id,
    // only returned in dev so you can test without reading the inbox
    ...(env.EXPOSE_DEV_TOKEN ? { devToken: token, devVerifyUrl: verifyUrl } : {}),
  });
}

async function handleVerify(request, env, url) {
  const token = url.searchParams.get("token");
  const email = (url.searchParams.get("email") || "").toLowerCase();
  if (!token) return json({ ok: false, error: "Missing token." }, 400);

  if (!env.VERIFY_TOKENS) {
    return json({ ok: false, error: "VERIFY_TOKENS KV namespace is not bound." }, 500);
  }

  const key = email ? `user:${email}` : null;
  let record = null;

  if (key) {
    record = await env.VERIFY_TOKENS.get(key, "json");
  } else {
    // no email given: scan for a matching token (small dataset, fine for demo)
    const list = await env.VERIFY_TOKENS.list({ prefix: "user:" });
    for (const k of list.keys) {
      const r = await env.VERIFY_TOKENS.get(k.name, "json");
      if (r && r.token === token) { record = r; break; }
    }
  }

  if (!record) return json({ ok: false, error: "Verification link is invalid or has expired." }, 404);
  if (record.token !== token) return json({ ok: false, error: "Token mismatch." }, 403);
  if (Date.now() > record.expiresAt) return json({ ok: false, error: "This link has expired. Request a new one." }, 410);

  record.verified = true;
  record.verifiedAt = Date.now();
  await env.VERIFY_TOKENS.put(`user:${record.email}`, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 30,
  });

  const session = await makeSession(
    { userId: record.userId, email: record.email, name: record.name, provider: record.provider },
    env.SESSION_SECRET || "dev-secret-change-me",
  );

  return json(
    { ok: true, message: "Email verified. You're signed in.", user: { email: record.email, name: record.name } },
    200,
    { "set-cookie": sessionCookie(session, request) },
  );
}

async function handleGoogleLogin(env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({
      ok: false,
      error: "Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).",
    }, 501);
  }
  const redirectUri = `${env.SITE_URL || url.origin}/api/google-callback`;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "select_account");
  return json({ ok: true, authUrl: auth.toString(), redirectUri });
}

async function handleGoogleCallback(request, env, url) {
  // Browsers get redirected back into the app; API clients get JSON.
  const wantsJson =
    url.searchParams.get("format") === "json" ||
    (request.headers.get("accept") || "").includes("application/json") &&
      !request.headers.get("accept").includes("text/html");
  const siteUrl = env.SITE_URL || url.origin;
  const back = (params) =>
    new Response(null, { status: 302, headers: { location: `${siteUrl}/?${params}` } });

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    if (wantsJson) return json({ ok: false, error: "Google sign-in is not configured." }, 501);
    return back("error=" + encodeURIComponent("Google sign-in is not configured."));
  }
  const code = url.searchParams.get("code");
  if (!code) {
    if (wantsJson) return json({ ok: false, error: "Missing authorization code." }, 400);
    return back("error=" + encodeURIComponent("Google did not send an authorization code."));
  }

  const redirectUri = `${siteUrl}/api/google-callback`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokens.access_token) {
    const msg = tokens.error_description || tokens.error || "Token exchange failed.";
    if (wantsJson) return json({ ok: false, error: "Token exchange failed.", details: tokens }, 502);
    return back("error=" + encodeURIComponent(msg));
  }

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const info = await infoRes.json().catch(() => ({}));
  if (!info.email) {
    if (wantsJson) return json({ ok: false, error: "Google did not return an email address." }, 502);
    return back("error=" + encodeURIComponent("Google did not return an email address."));
  }

  const email = String(info.email).toLowerCase();
  let record = env.VERIFY_TOKENS ? await env.VERIFY_TOKENS.get(`user:${email}`, "json") : null;

  if (!record) {
    record = {
      userId: crypto.randomUUID(),
      email,
      name: info.name || "",
      verified: info.email_verified === true || info.email_verified === "true",
      token: crypto.randomUUID(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
      provider: "google",
      googleId: info.sub,
    };
  } else {
    record.name = info.name || record.name;
    record.verified = record.verified || info.email_verified === true || info.email_verified === "true";
  }

  if (env.VERIFY_TOKENS) {
    await env.VERIFY_TOKENS.put(`user:${email}`, JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
  }

  // Google already verified the address, so the account is usable right away.
  // We still try to send a welcome/verification mail to THEIR address, but only
  // when a provider that can actually reach them is configured — the shared
  // Resend test sender can only ever reach the account owner, so we skip it
  // rather than burn a doomed API call on every third-party Google login.
  const verifyUrl = `${siteUrl}/api/verify?token=${record.token}&email=${encodeURIComponent(email)}`;
  const tpl = verificationEmail({ name: record.name, url: verifyUrl });
  const canReachAnyone =
    env.EMAIL_SENDING_ACTIVE === "true" ||
    (Boolean(env.RESEND_API_KEY) && !isSharedTestSender(env.RESEND_FROM));
  let mail = { ok: true, skipped: true };
  if (canReachAnyone) {
    mail = await sendEmail(env, {
      to: email,
      subject: "Welcome to Facebook Clone — confirm your email",
      html: tpl.html,
      text: tpl.text,
    });
  }

  const session = await makeSession(
    { userId: record.userId, email: record.email, name: record.name, provider: "google" },
    env.SESSION_SECRET || "dev-secret-change-me",
  );

  const cookie = sessionCookie(session, request);
  const payload = {
    ok: true,
    user: { email: record.email, name: record.name, verified: record.verified },
    emailSent: mail.ok === true,
    emailSkipped: Boolean(mail.skipped),
    emailError: mail.ok ? undefined : mail.error,
  };

  if (wantsJson) return json(payload, 200, { "set-cookie": cookie });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${siteUrl}/?signedin=1&name=${encodeURIComponent(record.name || record.email)}`,
      "set-cookie": cookie,
    },
  });
}

async function handleSession(request, env) {
  const session = await readSession(request, env.SESSION_SECRET || "dev-secret-change-me");
  if (!session) return json({ ok: true, user: null });

  let verified = false;
  if (env.VERIFY_TOKENS) {
    const record = await env.VERIFY_TOKENS.get(`user:${session.email}`, "json");
    verified = !!record?.verified;
  }
  return json({ ok: true, user: { ...session, verified } });
}

/* ------------------------------------------------------------------ */
/* chat  (NPC via the local OpenCode bridge)                           */
/* ------------------------------------------------------------------ */

const NPC = {
  id: "mika",
  name: "Mika",
  blurb: "29 · 瓦片 Vinyl 二手唱片行 · 中正區老電影院二樓",
};

/** Everyone you can message. Each one is a separate OpenCode agent with its own voice. */
const PEERS = {
  mika:  { id: "mika",  name: "Mika",  blurb: "29 · 瓦片 Vinyl 二手唱片行 · 中正區", color: "#f7b733" },
  ruri:  { id: "ruri",  name: "Ruri",  blurb: "26 · 自由插畫師 · 凌晨才活得像自己", color: "#a855f7" },
  kenji: { id: "kenji", name: "Kenji", blurb: "31 · 淡水 · 做衝浪板 也修車", color: "#06b6d4" },
  yumi:  { id: "yumi",  name: "Yumi",  blurb: "27 · 師大附近的小咖啡攤 · 三隻貓的房東", color: "#ec4899" },
  dane:  { id: "dane",  name: "Dane",  blurb: "34 · 台南 · 用過期底片拍照", color: "#10b981" },
};
const PEER_IDS = Object.keys(PEERS);
const peerOf = (id) => PEERS[String(id || "").toLowerCase()] || PEERS.mika;

async function handleMessages(request, env, session, url) {
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound." }, 500);
  const peer = peerOf(url?.searchParams.get("peer"));
  const { results } = await env.DB.prepare(
    "SELECT id, role, from_name, body, ts FROM messages WHERE user_email = ? AND peer = ? ORDER BY ts ASC LIMIT 200",
  ).bind(session.email, peer.id).all();

  const items = results.map((r) => ({
    id: r.id,
    role: r.role,
    from: r.from_name || undefined,
    text: r.body,
    ts: r.ts,
  }));

  const sess = await env.DB.prepare(
    "SELECT session_id FROM conversations WHERE user_email = ? AND peer = ?",
  ).bind(session.email, peer.id).first();

  return json({ ok: true, messages: items, sessionId: sess?.session_id ?? null, npc: peer, peers: PEERS });
}

async function handleChat(request, env, session) {
  if (!env.CHAT_BRIDGE_URL) {
    return json({ ok: false, error: "Chat bridge is not configured (CHAT_BRIDGE_URL)." }, 501);
  }
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Body must be JSON." }, 400); }
  const text = String(body?.text ?? "").trim();
  if (!text) return json({ ok: false, error: "Say something first." }, 400);
  if (text.length > 2000) return json({ ok: false, error: "That message is too long." }, 400);

  const peer = peerOf(body?.peer);
  const sess = await env.DB.prepare(
    "SELECT session_id FROM conversations WHERE user_email = ? AND peer = ?",
  ).bind(session.email, peer.id).first();
  const sessionId = sess?.session_id || null;

  // persist the user's message straight away so the UI can show it immediately
  const now = Date.now();
  const userMsg = {
    id: `u_${now}_${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    text,
    ts: now,
  };
  await env.DB.prepare(
    "INSERT INTO messages (id, user_email, role, from_name, body, ts, peer) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(userMsg.id, session.email, "user", null, text, now, peer.id).run();

  // ask the NPC (retry: quick tunnels occasionally flap with a 530)
  let reply, error;
  const bridgeUrl = env.CHAT_BRIDGE_URL.replace(/\/$/, "");
  const bridgeHeaders = {
    "content-type": "application/json",
    ...(env.CHAT_BRIDGE_TOKEN ? { "x-bridge-token": env.CHAT_BRIDGE_TOKEN } : {}),
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${bridgeUrl}/chat`, {
        method: "POST",
        headers: bridgeHeaders,
        body: JSON.stringify({ sessionId, text, user: session.email, agent: peer.id }),
        signal: AbortSignal.timeout(90_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        reply = data.reply;
        if (data.sessionId) {
          await env.DB.prepare(
            "INSERT INTO conversations (user_email, peer, session_id, updated_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(user_email, peer) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at",
          ).bind(session.email, peer.id, data.sessionId, Date.now()).run();
        }
        break;
      }
      error = data?.error || `Bridge returned ${res.status}.`;
      // 5xx from the tunnel is usually transient -> retry
      if (res.status < 500 || attempt === 3) break;
    } catch (e) {
      error = `Could not reach the chat bridge: ${String(e?.message || e)}`;
      if (attempt === 3) break;
    }
    await new Promise((r) => setTimeout(r, 1200 * attempt));
  }

  if (!reply) {
    return json({ ok: false, error, userMessage: userMsg }, 502);
  }

  const ts = Date.now();
  const npcMsg = {
    id: `n_${ts}_${Math.random().toString(36).slice(2, 8)}`,
    role: "npc",
    from: peer.name,
    text: reply,
    ts,
  };
  await env.DB.prepare(
    "INSERT INTO messages (id, user_email, role, from_name, body, ts, peer) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(npcMsg.id, session.email, "npc", peer.name, reply, ts, peer.id).run();

  return json({ ok: true, userMessage: userMsg, message: npcMsg, npc: peer });
}

async function handleChatReset(request, env, session) {
  if (!env.DB) return json({ ok: false, error: "D1 database is not bound." }, 500);
  let body = {};
  try { body = await request.json(); } catch {}
  const peer = peerOf(body?.peer);
  const sess = await env.DB.prepare(
    "SELECT session_id FROM conversations WHERE user_email = ? AND peer = ?",
  ).bind(session.email, peer.id).first();

  if (sess?.session_id && env.CHAT_BRIDGE_URL) {
    try {
      await fetch(`${env.CHAT_BRIDGE_URL.replace(/\/$/, "")}/reset`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.CHAT_BRIDGE_TOKEN ? { "x-bridge-token": env.CHAT_BRIDGE_TOKEN } : {}),
        },
        body: JSON.stringify({ sessionId: sess.session_id, user: session.email, agent: peer.id }),
      });
    } catch {}
  }
  await env.DB.prepare("DELETE FROM messages WHERE user_email = ? AND peer = ?").bind(session.email, peer.id).run();
  await env.DB.prepare("DELETE FROM conversations WHERE user_email = ? AND peer = ?").bind(session.email, peer.id).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* social graph: profiles, posts, likes, comments, friends              */
/* ------------------------------------------------------------------ */

const SEED_PEOPLE = [
  { email: "mika@fbclone.app", name: "Mika", bio: "29 · 瓦片 Vinyl 二手唱片行 · 雨天下午最愛整理唱機", color: "#f7b733", is_npc: 1 },
  { email: "ruri@fbclone.app", name: "Ruri", bio: "插畫師 · 貓 · 咖啡 · 半夜才活得比較像自己", color: "#a855f7", is_npc: 1 },
  { email: "kenji@fbclone.app", name: "Kenji", bio: "衝浪 / 單車 / 修理一切壞掉的東西", color: "#06b6d4", is_npc: 1 },
  { email: "yumi@fbclone.app", name: "Yumi", bio: "咖啡師 · 三隻貓的房東 · 早上五點起床", color: "#ec4899", is_npc: 1 },
  { email: "dane@fbclone.app", name: "Dane", bio: "在城市裡找海 · 攝影 · 底片", color: "#10b981", is_npc: 1 },
];

const SEED_POSTS = [
  ["mika@fbclone.app", "今天在店裡翻到一張 1974 年的爵士錄音，封面都磨掉了但聲音還好好的。有時候覺得二手的東西比新的更耐看。"],
  ["yumi@fbclone.app", "早上五點起床第一件事是磨豆子。店門口那隻橘貓又來了，今天終於肯讓我摸一下了 🌞"],
  ["ruri@fbclone.app", "畫到凌晨三點，窗外開始下雨。決定把這張畫完就睡。"],
  ["kenji@fbclone.app", "單車壞了第三次，終於學會自己換胎。下次直接騎去海邊。"],
  ["mika@fbclone.app", "有人問我為什麼開唱片行。我說因為我喜歡別人挑到喜歡的東西時的那個表情。就這樣。"],
  ["dane@fbclone.app", "拍了兩卷底片，一卷全廢掉。但那卷廢掉的反而很好看。"],
  ["yumi@fbclone.app", "今天的拿鐵拉花是隻貓。客人說這貓看起來很兇。"],
  ["ruri@fbclone.app", "有沒有人想看我畫的貓？九張不同表情，已經畫到第四張了。"],
];

let seedPromise = null;
function ensureSeed(env) {
  if (!env.DB) return Promise.resolve();
  if (!seedPromise) {
    seedPromise = (async () => {
      const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM profiles").all();
      if (results[0].n > 0) return;
      const now = Date.now();
      for (const p of SEED_PEOPLE) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO profiles (email, name, bio, color, is_npc, created_at) VALUES (?,?,?,?,?,?)",
        ).bind(p.email, p.name, p.bio, p.color, p.is_npc, now - 86400000 * 30).run();
      }
      let i = 0;
      for (const [author, body] of SEED_POSTS) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO posts (id, author_email, body, ts) VALUES (?,?,?,?)",
        ).bind(`seed_${i++}`, author, body, now - (SEED_POSTS.length - i) * 3600000).run();
      }
    })().catch((e) => { seedPromise = null; console.error("seed failed", e); });
  }
  return seedPromise;
}

/** Make sure the signed-in user has a profile row and is friends with the seed crew. */
async function ensureUser(env, email, name) {
  if (!env.DB) return;
  await ensureSeed(env);
  const existing = await env.DB.prepare("SELECT email FROM profiles WHERE email = ?").bind(email).first();
  if (existing) return;   // already set up — do NOT touch their friendships

  // first time we see this person: create the profile and seed their friends
  const palette = ["#1877f2", "#7c3aed", "#0ea5e9", "#e11d48", "#059669", "#d97706"];
  const color = palette[Math.floor(Math.random() * palette.length)];
  await env.DB.prepare(
    "INSERT OR REPLACE INTO profiles (email, name, bio, color, is_npc, created_at) VALUES (?,?,?,?,0,?)",
  ).bind(email, name || email.split("@")[0], "剛加入 Facebook Clone", color, Date.now()).run();

  for (const p of SEED_PEOPLE) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO friends (owner_email, friend_email, ts) VALUES (?,?,?)",
    ).bind(email, p.email, Date.now()).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO friends (owner_email, friend_email, ts) VALUES (?,?,?)",
    ).bind(p.email, email, Date.now()).run();
  }
}

async function handleFeed(env, me, name) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  await ensureSeed(env);
  await ensureUser(env, me, name);

  const { results: posts } = await env.DB.prepare(
    `SELECT p.id, p.author_email, p.body, p.ts, p.edited_at,
            pr.name AS author_name, pr.color AS author_color, pr.is_npc,
            (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id AND l.user_email = ?) AS liked_by_me,
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p
       LEFT JOIN profiles pr ON pr.email = p.author_email
      WHERE p.author_email = ?
         OR p.author_email IN (SELECT friend_email FROM friends WHERE owner_email = ?)
      ORDER BY p.ts DESC
      LIMIT 50`,
  ).bind(me, me, me).all();

  return json({
    ok: true,
    posts: posts.map((p) => ({
      id: p.id,
      author: p.author_name || p.author_email,
      authorEmail: p.author_email,
      color: p.author_color || "#1877f2",
      isNpc: !!p.is_npc,
      body: p.body,
      ts: p.ts,
      edited: !!p.edited_at,
      likes: p.like_count,
      liked: p.liked_by_me > 0,
      comments: p.comment_count,
    })),
  });
}

async function handleCreatePost(env, me, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  const text = sanitizeText(body?.body, 2000);
  if (!text) return json({ ok: false, error: "Write something first." }, 400);
  const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare("INSERT INTO posts (id, author_email, body, ts) VALUES (?,?,?,?)")
    .bind(id, me, text, Date.now()).run();
  await resolveMentions(env, me, text);
  return json({ ok: true, id });
}

async function handleToggleLike(env, me, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  const postId = String(body?.postId ?? "");
  if (!postId) return json({ ok: false, error: "postId required." }, 400);

  const access = await canSeePost(env, me, postId);
  if (!access.ok) {
    if (access.reason === "notfound") return json({ ok: false, error: "Post not found." }, 404);
    return json({ ok: false, error: "You don't have permission to interact with this post." }, 403);
  }

  const existing = await env.DB.prepare(
    "SELECT post_id FROM likes WHERE post_id = ? AND user_email = ?",
  ).bind(postId, me).first();
  if (existing) {
    await env.DB.prepare("DELETE FROM likes WHERE post_id = ? AND user_email = ?").bind(postId, me).run();
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO likes (post_id, user_email, ts) VALUES (?,?,?)")
      .bind(postId, me, Date.now()).run();
    await notify(env, { to: access.post.author_email, from: me, kind: "like", postId });
  }
  const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE post_id = ?").bind(postId).all();
  return json({ ok: true, liked: !existing, likes: results[0].n });
}

/** Can `me` see this post? (own post, or the author is one of my friends) */
async function canSeePost(env, me, postId) {
  const post = await env.DB.prepare("SELECT author_email FROM posts WHERE id = ?").bind(postId).first();
  if (!post) return { ok: false, reason: "notfound" };
  if (post.author_email === me) return { ok: true, post };
  const fr = await env.DB.prepare(
    "SELECT friend_email FROM friends WHERE owner_email = ? AND friend_email = ?",
  ).bind(me, post.author_email).first();
  return fr ? { ok: true, post } : { ok: false, reason: "forbidden" };
}

/**
 * Make sure ANOTHER person has a profile row.
 * Their profile is normally created when they first load the app, but they might
 * not have done that yet (e.g. they signed in and were immediately invited).
 */
async function ensureOtherProfile(env, email) {
  if (!env.DB || !email) return;
  const rec = env.VERIFY_TOKENS ? await env.VERIFY_TOKENS.get(`user:${email}`, "json") : null;
  await ensureUser(env, email, rec?.name || String(email).split("@")[0]);
}

/** Fire a notification, respecting the recipient's preferences. */
async function notify(env, { to, from, kind, postId, text }) {
  if (!env.DB || !to || to === from) return;
  await ensureOtherProfile(env, to);
  const s = await env.DB.prepare("SELECT * FROM settings WHERE user_email = ?").bind(to).first();
  const pref = {
    like: s?.notify_likes ?? 1,
    comment: s?.notify_comments ?? 1,
    friend: s?.notify_friends ?? 1,
    mention: 1,
  };
  if (!pref[kind]) return;
  const fromName =
    (await env.DB.prepare("SELECT name FROM profiles WHERE email = ?").bind(from).first())?.name || from;
  await env.DB.prepare(
    "INSERT INTO notifications (id, user_email, from_email, from_name, kind, post_id, text, ts, read) VALUES (?,?,?,?,?,?,?,?,0)",
  ).bind(`n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, to, from, fromName, kind, postId ?? null, text ?? null, Date.now()).run();
}

async function handleComments(env, me, body, wantPost) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  const postId = String(body?.postId ?? "");
  if (!postId) return json({ ok: false, error: "postId required." }, 400);

  // permission check — never let a stranger read (or write to) someone else's post
  const access = await canSeePost(env, me, postId);
  if (!access.ok) {
    if (access.reason === "notfound") return json({ ok: false, error: "Post not found." }, 404);
    return json({ ok: false, error: "You don't have permission to view this post." }, 403);
  }

  if (wantPost) {
    const text = sanitizeText(body?.body, 1000);
    if (!text) return json({ ok: false, error: "Write a comment first." }, 400);
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare("INSERT INTO comments (id, post_id, user_email, body, ts) VALUES (?,?,?,?,?)")
      .bind(id, postId, me, text, Date.now()).run();
    await notify(env, { to: access.post.author_email, from: me, kind: "comment", postId, text });
  }

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.user_email, c.body, c.ts, pr.name AS author_name, pr.color AS author_color
       FROM comments c LEFT JOIN profiles pr ON pr.email = c.user_email
      WHERE c.post_id = ? ORDER BY c.ts ASC LIMIT 100`,
  ).bind(postId).all();

  return json({
    ok: true,
    comments: results.map((c) => ({
      id: c.id,
      author: c.author_name || c.user_email,
      color: c.author_color || "#1877f2",
      body: c.body,
      ts: c.ts,
    })),
  });
}

async function handleProfile(env, me, name, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  await ensureSeed(env);
  await ensureUser(env, me, name);

  if (body?.name !== undefined || body?.bio !== undefined) {
    const newName = sanitizeText(body.name, 60);
    const bio = sanitizeText(body.bio, 200);
    if (newName) await env.DB.prepare("UPDATE profiles SET name = ? WHERE email = ?").bind(newName, me).run();
    if (body.bio !== undefined) await env.DB.prepare("UPDATE profiles SET bio = ? WHERE email = ?").bind(bio, me).run();
  }

  const prof = await env.DB.prepare("SELECT * FROM profiles WHERE email = ?").bind(me).first();
  const stats = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM posts   WHERE author_email = ?) AS posts,
       (SELECT COUNT(*) FROM friends WHERE owner_email  = ?) AS friends,
       (SELECT COUNT(*) FROM likes   WHERE user_email   = ?) AS likes`,
  ).bind(me, me, me).first();

  const { results: myPosts } = await env.DB.prepare(
    `SELECT p.id, p.body, p.ts,
            (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p WHERE p.author_email = ? ORDER BY p.ts DESC LIMIT 50`,
  ).bind(me).all();

  return json({
    ok: true,
    profile: {
      email: prof?.email,
      name: prof?.name,
      bio: prof?.bio,
      color: prof?.color || "#1877f2",
      isNpc: !!prof?.is_npc,
      createdAt: prof?.created_at,
    },
    stats: { posts: stats?.posts ?? 0, friends: stats?.friends ?? 0, likes: stats?.likes ?? 0 },
    posts: myPosts.map((p) => ({
      id: p.id, body: p.body, ts: p.ts, likes: p.like_count, comments: p.comment_count,
    })),
  });
}

const NPC_EMAILS = new Set(SEED_PEOPLE.map((p) => p.email));

async function handleFriends(env, me, name, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  await ensureSeed(env);
  await ensureUser(env, me, name);

  const other = String(body?.email ?? "").trim().toLowerCase();
  const action = String(body?.action ?? (body?.toggle ? "toggle" : "")).trim();

  if (other && action) {
    // make sure they exist as a person before we try to connect
    await ensureOtherProfile(env, other);
    const isFriend = await env.DB.prepare(
      "SELECT friend_email FROM friends WHERE owner_email = ? AND friend_email = ?",
    ).bind(me, other).first();

    const setStatus = async (from, to, status) => {
      await env.DB.prepare(
        "INSERT INTO friend_requests (from_email, to_email, status, ts) VALUES (?,?,?,?) " +
          "ON CONFLICT(from_email, to_email) DO UPDATE SET status = excluded.status, ts = excluded.ts",
      ).bind(from, to, status, Date.now()).run();
    };

    const addFriend = async (a, b) => {
      await env.DB.prepare("INSERT OR IGNORE INTO friends (owner_email, friend_email, ts) VALUES (?,?,?)")
        .bind(a, b, Date.now()).run();
      await env.DB.prepare("INSERT OR IGNORE INTO friends (owner_email, friend_email, ts) VALUES (?,?,?)")
        .bind(b, a, Date.now()).run();
    };

    if (action === "request") {
      if (!isFriend) {
        // NPCs are always keen -> accept straight away
        if (NPC_EMAILS.has(other)) {
          await addFriend(me, other);
          await setStatus(me, other, "accepted");
          await notify(env, { to: other, from: me, kind: "friend" });
        } else {
          const pending = await env.DB.prepare(
            "SELECT status FROM friend_requests WHERE from_email = ? AND to_email = ? AND status = 'pending'",
          ).bind(me, other).first();
          if (!pending) {
            await setStatus(me, other, "pending");
            await notify(env, { to: other, from: me, kind: "friend" });
          }
        }
      }
    } else if (action === "accept") {
      await addFriend(me, other);
      await setStatus(other, me, "accepted");
      await notify(env, { to: other, from: me, kind: "friend" });
    } else if (action === "decline") {
      await setStatus(other, me, "declined");
    } else if (action === "remove") {
      await env.DB.prepare("DELETE FROM friends WHERE owner_email = ? AND friend_email = ?").bind(me, other).run();
      await env.DB.prepare("DELETE FROM friend_requests WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?)")
        .bind(me, other, other, me).run();
    } else if (action === "toggle" || action === "") {
      if (isFriend) {
        await env.DB.prepare("DELETE FROM friends WHERE owner_email = ? AND friend_email = ?").bind(me, other).run();
        await env.DB.prepare("DELETE FROM friend_requests WHERE (from_email = ? AND to_email = ?) OR (from_email = ? AND to_email = ?)")
          .bind(me, other, other, me).run();
      } else {
        if (NPC_EMAILS.has(other)) {
          await addFriend(me, other);
          await notify(env, { to: other, from: me, kind: "friend" });
        } else {
          await setStatus(me, other, "pending");
          await notify(env, { to: other, from: me, kind: "friend" });
        }
      }
    }
  }

  const { results } = await env.DB.prepare(
    `SELECT pr.email, pr.name, pr.bio, pr.color, pr.is_npc,
            CASE WHEN f.friend_email IS NULL THEN 0 ELSE 1 END AS is_friend,
            (SELECT COUNT(*) FROM posts p WHERE p.author_email = pr.email) AS post_count,
            COALESCE((SELECT fr.status FROM friend_requests fr
                       WHERE fr.from_email = ? AND fr.to_email = pr.email), '') AS out_status,
            COALESCE((SELECT fr.status FROM friend_requests fr
                       WHERE fr.from_email = pr.email AND fr.to_email = ?), '') AS in_status
       FROM profiles pr
       LEFT JOIN friends f ON f.friend_email = pr.email AND f.owner_email = ?
      WHERE pr.email <> ?
      ORDER BY (CASE WHEN f.friend_email IS NULL THEN 1 ELSE 0 END),
               (SELECT COUNT(*) FROM friend_requests x WHERE x.from_email = pr.email AND x.to_email = ? AND x.status='pending') DESC,
               pr.name ASC`,
  ).bind(me, me, me, me, me).all();

  return json({
    ok: true,
    people: results.map((p) => ({
      email: p.email, name: p.name, bio: p.bio, color: p.color,
      isNpc: !!p.is_npc, isFriend: !!p.is_friend, posts: p.post_count,
      requestSent: p.out_status === "pending",
      requestIn: p.in_status === "pending",
    })),
  });
}

/** Conversation list — one thread per person you've messaged. */
async function handleThreads(env, me) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  const { results } = await env.DB.prepare(
    `SELECT peer, MAX(ts) AS last_ts, COUNT(*) AS n
       FROM messages WHERE user_email = ?
      GROUP BY peer ORDER BY last_ts DESC`,
  ).bind(me).all();

  const threads = results.map((r) => {
    const p = peerOf(r.peer);
    return { who: p.name, peer: p.id, blurb: p.blurb, color: p.color, lastTs: r.last_ts, count: r.n };
  });

  // always offer every peer, so you can start a new conversation
  for (const p of Object.values(PEERS)) {
    if (!threads.some((t) => t.peer === p.id)) {
      threads.push({ who: p.name, peer: p.id, blurb: p.blurb, color: p.color, lastTs: 0, count: 0 });
    }
  }
  threads.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));

  return json({ ok: true, threads, peers: PEERS });
}

/* ------------------------------------------------------------------ */
/* notifications, post editing, mentions, search, settings              */
/* ------------------------------------------------------------------ */

async function handleNotifications(env, me, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);

  if (body?.readAll) {
    await env.DB.prepare("UPDATE notifications SET read = 1 WHERE user_email = ?").bind(me).run();
  } else if (body?.id) {
    await env.DB.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND user_email = ?")
      .bind(String(body.id), me).run();
  }

  const { results } = await env.DB.prepare(
    `SELECT id, from_email, from_name, kind, post_id, text, ts, read
       FROM notifications WHERE user_email = ? ORDER BY ts DESC LIMIT 50`,
  ).bind(me).all();

  const unread = results.filter((n) => !n.read).length;
  return json({
    ok: true,
    unread,
    notifications: results.map((n) => ({
      id: n.id, from: n.from_name || n.from_email, kind: n.kind,
      postId: n.post_id, text: n.text, ts: n.ts, read: !!n.read,
    })),
  });
}

async function handleEditPost(env, me, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  const id = String(body?.id ?? "");
  const text = String(body?.body ?? "").trim();
  if (!id) return json({ ok: false, error: "id required." }, 400);
  if (!text) return json({ ok: false, error: "Post can't be empty." }, 400);

  const post = await env.DB.prepare("SELECT author_email FROM posts WHERE id = ?").bind(id).first();
  if (!post) return json({ ok: false, error: "Post not found." }, 404);
  if (post.author_email !== me) return json({ ok: false, error: "You can only edit your own posts." }, 403);

  await env.DB.prepare("UPDATE posts SET body = ?, edited_at = ? WHERE id = ?")
    .bind(text.slice(0, 2000), Date.now(), id).run();
  return json({ ok: true });
}

async function handleDeletePost(env, me, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  const id = String(body?.id ?? "");
  if (!id) return json({ ok: false, error: "id required." }, 400);

  const post = await env.DB.prepare("SELECT author_email FROM posts WHERE id = ?").bind(id).first();
  if (!post) return json({ ok: false, error: "Post not found." }, 404);
  if (post.author_email !== me) return json({ ok: false, error: "You can only delete your own posts." }, 403);

  await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM likes WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

/** People search — friends first, then everyone. */
async function handleSearch(env, me, q) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  const term = String(q ?? "").trim().toLowerCase();
  if (!term) return json({ ok: true, people: [], posts: [] });

  const like = `%${term}%`;
  const { results: people } = await env.DB.prepare(
    `SELECT pr.email, pr.name, pr.bio, pr.color, pr.is_npc,
            CASE WHEN f.friend_email IS NULL THEN 0 ELSE 1 END AS is_friend
       FROM profiles pr
       LEFT JOIN friends f ON f.friend_email = pr.email AND f.owner_email = ?
      WHERE (LOWER(pr.name) LIKE ? OR LOWER(pr.email) LIKE ?)
        AND pr.email <> ?
      ORDER BY is_friend DESC, pr.name LIMIT 20`,
  ).bind(me, like, like, me).all();

  const { results: posts } = await env.DB.prepare(
    `SELECT p.id, p.body, p.ts, pr.name AS author, pr.color
       FROM posts p LEFT JOIN profiles pr ON pr.email = p.author_email
      WHERE LOWER(p.body) LIKE ?
        AND (p.author_email = ? OR p.author_email IN (SELECT friend_email FROM friends WHERE owner_email = ?))
      ORDER BY p.ts DESC LIMIT 20`,
  ).bind(like, me, me).all();

  return json({
    ok: true,
    people: people.map((p) => ({
      email: p.email, name: p.name, bio: p.bio, color: p.color,
      isNpc: !!p.is_npc, isFriend: !!p.is_friend,
    })),
    posts: posts.map((p) => ({ id: p.id, body: p.body, ts: p.ts, author: p.author, color: p.color })),
  });
}

async function handleSettings(env, me, name, body) {
  if (!env.DB) return json({ ok: false, error: "D1 not bound." }, 500);
  await ensureUser(env, me, name);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO settings (user_email, notify_likes, notify_comments, notify_friends, updated_at) VALUES (?,1,1,1,?)",
  ).bind(me, Date.now()).run();

  if (body && typeof body === "object" && Object.keys(body).length) {
    const likes = body.notify_likes ? 1 : 0;
    const comments = body.notify_comments ? 1 : 0;
    const friends = body.notify_friends ? 1 : 0;
    if (body.name) {
      await env.DB.prepare("UPDATE profiles SET name = ? WHERE email = ?")
        .bind(sanitizeText(body.name, 60), me).run();
    }
    if (body.bio !== undefined) {
      await env.DB.prepare("UPDATE profiles SET bio = ? WHERE email = ?")
        .bind(sanitizeText(body.bio, 200), me).run();
    }
    await env.DB.prepare(
      "UPDATE settings SET notify_likes = ?, notify_comments = ?, notify_friends = ?, updated_at = ? WHERE user_email = ?",
    ).bind(likes, comments, friends, Date.now(), me).run();
  }

  const s = await env.DB.prepare("SELECT * FROM settings WHERE user_email = ?").bind(me).first();
  const prof = await env.DB.prepare("SELECT email, name, bio, color, created_at FROM profiles WHERE email = ?").bind(me).first();
  return json({
    ok: true,
    settings: {
      notify_likes: !!(s?.notify_likes ?? 1),
      notify_comments: !!(s?.notify_comments ?? 1),
      notify_friends: !!(s?.notify_friends ?? 1),
    },
    account: { email: prof?.email, name: prof?.name, bio: prof?.bio, color: prof?.color, createdAt: prof?.created_at },
  });
}

/** @mentions — resolve @name against the poster's friends. */
async function resolveMentions(env, me, text) {
  const names = [...new Set([...String(text).matchAll(/@([\p{L}\p{N}_.]{1,40})/gu)].map((m) => m[1].toLowerCase()))];
  if (!names.length) return { mentioned: [], text };

  const { results } = await env.DB.prepare(
    `SELECT pr.email, pr.name FROM profiles pr
       WHERE LOWER(pr.name) IN (${names.map(() => "?").join(",")})
          OR LOWER(SUBSTR(pr.email, 1, INSTR(pr.email, '@') - 1)) IN (${names.map(() => "?").join(",")})`,
  ).bind(...names, ...names).all();

  const mentioned = results.map((r) => r.email);
  for (const email of mentioned) {
    await notify(env, { to: email, from: me, kind: "mention", text: String(text).slice(0, 140) });
  }
  return { mentioned, text };
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/api/config") {
        return json({
          ok: true,
          resend: Boolean(env.RESEND_API_KEY),
          resendFrom: env.RESEND_FROM || null,
          google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
          kv: Boolean(env.VERIFY_TOKENS),
          chat: Boolean(env.CHAT_BRIDGE_URL),
          npc: NPC,
          peers: PEERS,
          email: {
            provider: env.EMAIL_SENDING_ACTIVE === "true" ? "cloudflare" : (env.RESEND_API_KEY ? "resend" : null),
            canEmailAnyone: env.EMAIL_SENDING_ACTIVE === "true",
            from: env.EMAIL_SENDING_ACTIVE === "true" ? env.EMAIL_FROM : (env.RESEND_FROM || null),
          },
          siteUrl: env.SITE_URL || url.origin,
        });
      }

      if (path === "/api/send-verification" && request.method === "POST") {
        return handleSendVerification(request, env, url);
      }

      if (path === "/api/verify" && request.method === "GET") {
        return handleVerify(request, env, url);
      }

      if (path === "/api/google-login" && request.method === "GET") {
        return handleGoogleLogin(env, url);
      }

      if (path === "/api/google-callback" && request.method === "GET") {
        return handleGoogleCallback(request, env, url);
      }

      if (path === "/api/session" && request.method === "GET") {
        return handleSession(request, env);
      }

      if (path === "/api/logout" && request.method === "POST") {
        return json({ ok: true }, 200, {
          "set-cookie": clearSessionCookie(request),
        });
      }

      /* ---- social graph (requires a signed-in session) ---- */
      if (path.startsWith("/api/")) {
        const s = await readSession(request, env.SESSION_SECRET || "dev-secret-change-me");
        if (!s) return json({ ok: false, error: "Sign in first." }, 401);

        if (path === "/api/feed" && request.method === "GET") {
          return handleFeed(env, s.email, s.name);
        }
        if (path === "/api/posts" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleCreatePost(env, s.email, b);
        }
        if (path === "/api/posts/edit" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleEditPost(env, s.email, b);
        }
        if (path === "/api/posts/delete" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleDeletePost(env, s.email, b);
        }
        if (path === "/api/posts/like" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleToggleLike(env, s.email, b);
        }
        if (path === "/api/notifications" && request.method === "GET") {
          return handleNotifications(env, s.email, {});
        }
        if (path === "/api/notifications" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleNotifications(env, s.email, b);
        }
        if (path === "/api/search" && request.method === "GET") {
          return handleSearch(env, s.email, url.searchParams.get("q"));
        }
        if (path === "/api/posts/comments" && request.method === "GET") {
          const b = Object.fromEntries(url.searchParams);
          return handleComments(env, s.email, b, false);
        }
        if (path === "/api/posts/comments" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleComments(env, s.email, b, true);
        }
        if (path === "/api/profile" && request.method === "GET") {
          return handleProfile(env, s.email, s.name, {});
        }
        if (path === "/api/profile" && request.method === "PATCH") {
          const b = await request.json().catch(() => ({}));
          return handleProfile(env, s.email, s.name, b);
        }
        if (path === "/api/friends" && request.method === "GET") {
          return handleFriends(env, s.email, s.name, {});
        }
        if (path === "/api/friends" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleFriends(env, s.email, s.name, b);
        }
        if (path === "/api/threads" && request.method === "GET") {
          return handleThreads(env, s.email);
        }
        if (path === "/api/settings" && request.method === "GET") {
          return handleSettings(env, s.email, s.name, null);
        }
        if (path === "/api/settings" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          return handleSettings(env, s.email, s.name, b);
        }
      }

      /* ---- chat (requires a signed-in session) ---- */
      if (path === "/api/messages" && request.method === "GET") {
        const s = await readSession(request, env.SESSION_SECRET || "dev-secret-change-me");
        if (!s) return json({ ok: false, error: "Sign in to chat." }, 401);
        return handleMessages(request, env, s, url);
      }

      if (path === "/api/chat" && request.method === "POST") {
        const s = await readSession(request, env.SESSION_SECRET || "dev-secret-change-me");
        if (!s) return json({ ok: false, error: "Sign in to chat." }, 401);
        return handleChat(request, env, s);
      }

      if (path === "/api/chat/reset" && request.method === "POST") {
        const s = await readSession(request, env.SESSION_SECRET || "dev-secret-change-me");
        if (!s) return json({ ok: false, error: "Sign in to chat." }, 401);
        return handleChatReset(request, env, s);
      }

      // Unknown API path -> JSON 404 (not the SPA HTML, which would confuse clients)
      if (path.startsWith("/api/")) {
        return json({ ok: false, error: `Unknown endpoint: ${path}` }, 404);
      }

      // static assets / SPA fallback
      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(request);
        if (res.status !== 404) return res;
        const shell = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
        if (shell.status === 200) return shell;
        return res;
      }

      return html(
        `<!doctype html><meta charset="utf-8"><title>Facebook Clone</title>
         <body style="font-family:system-ui;padding:3rem;max-width:40rem;margin:auto">
         <h1>Facebook Clone Worker is running</h1>
         <p>No static assets bound. API routes available:</p>
         <ul><li>GET /api/config</li><li>POST /api/send-verification</li>
         <li>GET /api/verify?token=…</li><li>GET /api/session</li></ul></body>`,
        200,
      );
    } catch (err) {
      return json({ ok: false, error: "Server error", details: String(err?.message || err) }, 500);
    }
  },
};
