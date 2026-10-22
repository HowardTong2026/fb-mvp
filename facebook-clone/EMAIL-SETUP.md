# Sending email to third parties

## Current state

| Recipient | Result |
|---|---|
| `howardtong2026@gmail.com` (the Resend account address) | ✅ delivered |
| anyone else | ❌ HTTP 403 with an explanation |

**Why:** Resend's `onboarding@resend.dev` is a *shared test sender*. Resend only lets it
deliver to the address registered on the account. This is a Resend rule, not a bug —
it applies to every account on the free plan without a verified domain.

**Also worth knowing:** the Google sign-in flow never sends anything to *your* inbox.
It sends to the signed-in user's own address — and skips the attempt entirely when the
provider can't reach anyone but you, so there's no wasted API call on their account.

---

## The fix: Cloudflare Email Sending (free)

Cloudflare has its own transactional email service, and it **sends to any recipient**
once a domain is onboarded. It's free, needs no API key (it uses a Workers binding),
and it's native to the Worker you're already running.

```
https://developers.cloudflare.com/email-service/
```

### What you need

**1. An active Cloudflare zone** — a domain whose nameservers point at Cloudflare.

You have one candidate already: `howardtong.eu.org` (zone `2234fc415ace935747edd970d0dc6f18`).
It's currently `pending` — waiting for eu.org to delegate. Once that happens it flips to
`active` and you can use it. Approval takes 1–14 days.

> If you want it today instead, register a domain on Cloudflare Registrar
> (`howardtong.com` was $10.46) — the `cf registrar` CLI can do it once a payment
> method is on the account.

**2. A Cloudflare API token with the "Email Sending: Edit" permission**

Create one at https://dash.cloudflare.com/profile/api-tokens
(uses the **API Tokens** template → `Edit` → permission `Email Sending`).
Save it to:

```
C:\Users\user\Desktop\AI學習第九課\cf-email-token.txt
```

### Then run

```powershell
cd "C:\Users\user\Desktop\AI學習第九課\facebook-clone"
node setup-email-sending.mjs howardtong.eu.org
```

That script:
1. checks the zone is active
2. runs `wrangler email sending enable <domain>` — Cloudflare auto-adds
   SPF, DKIM, DMARC and the bounce-MX records
3. sets `EMAIL_SENDING_ACTIVE = "true"` and `EMAIL_FROM` in `wrangler.toml`
4. deploys

### Prove it

```powershell
node setup-email-sending.mjs howardtong.eu.org someone@gmail.com
```

The last step POSTs to `/api/send-verification` with that address. A `200` means a real
email went out to a third party.

---

## How the Worker decides

`src/index.js` → `sendEmail()`:

```
EMAIL_SENDING_ACTIVE === "true"  →  env.EMAIL.send(...)      (Cloudflare, reaches anyone)
otherwise                        →  Resend REST API          (account address only)
```

`env.EMAIL` is the Workers binding:

```toml
[[send_email]]
name = "EMAIL"
```

It is already bound in `wrangler.toml` — the deploy succeeds either way, and the app
simply skips the Cloudflare path until you flip `EMAIL_SENDING_ACTIVE` to `"true"`.
That avoids a doomed API call on every send.

---

## Resend alternative (if you prefer)

Resend's free tier is 3,000 emails/month, but it also needs a verified domain.
The easy path once you have one:

1. https://resend.com/domains → **Add Domain**
2. Click **"Sign in to Cloudflare"** → authorise
   (Resend uses *Domain Connect* and writes its own MX/SPF/DKIM records into your
   Cloudflare account — no copy-pasting, and no full-access API key needed)
3. Set `RESEND_FROM = "Facebook Clone <noreply@yourdomain.com>"` in `wrangler.toml`
4. Set `RESEND_ACCOUNT_EMAIL` to a comma list of addresses allowed to use the shared sender
   (or just leave it — with a real domain the shared-sender rule doesn't apply)

Note: with a **real** `RESEND_FROM` domain, Resend also reaches any third party, so the
`RESEND_ACCOUNT_EMAIL` restriction stops applying automatically.
