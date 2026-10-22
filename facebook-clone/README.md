# Facebook Clone — Cloudflare Workers + Resend

A social-network-style signup/login app running on Cloudflare Workers.
Plain Worker (no build step). Email verification via **Resend**, sign-in via **Google OAuth 2.0**.

## Live URL

```
https://facebook-clone.howardtong2026.workers.dev
```

Deployed to the real Cloudflare account `howardtong2026@gmail.com` (account id
`23ab8b3e9d6e8e8401ddc78b3513bbc0`). Permanent — no temporary-account expiry.

Deploy with:
```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
npx wrangler deploy
```

(or `npx wrangler login` for an interactive session)

## Status

| Component | State |
|---|---|
| Frontend (static SPA) | ✅ live |
| `POST /api/send-verification` | ✅ live, **real emails sending via Resend** |
| `GET /api/verify` | ✅ live (KV-backed) |
| `GET /api/google-login` + `/api/google-callback` | ✅ live + credentials set |
| `GET /api/session` | ✅ live |
| `POST /api/logout` | ✅ live |
| `RESEND_API_KEY` secret | ✅ set (send-only key from `Desktop/AI學習第九課/Resend API key.txt`) |
| `CHAT_BRIDGE_TOKEN` secret | ✅ set |
| KV namespace `VERIFY_TOKENS` | ✅ created (`5b08759a437f4ef590ad425cdaf905b5`) |
| D1 database `fbclone` | ✅ created (`9b14dc33-d07e-4eef-b4b8-331e1b6c90d7`) |
| NPC chat (Mika via OpenCode) | ✅ live |
| Google OAuth credentials | ✅ set |

### Verified end-to-end (10/10 against the live URL)

```
GET  /                          -> 200, 19.3KB HTML
GET  /api/config                -> {"ok":true,"resend":true,"google":true,"chat":true}
POST /api/send-verification     -> 400 on bad email ✓
POST /api/send-verification     -> 200 {"ok":true,"resendId":"01a16254-…"}  ← real email sent
GET  /api/verify                -> 200 {"ok":true,"user":{…}} + fb_session cookie
GET  /api/session               -> {"ok":true,"user":{…,"verified":true}}
POST /api/logout                -> 200
GET  /api/session               -> {"ok":true,"user":null}
GET  /api/google-login          -> 200 (auth URL with the right client_id + redirect_uri)
GET  /api/google-callback       -> 302 -> back into the app
GET  /api/messages              -> 401 signed out / 200 signed in ✓
POST /api/chat                  -> 200 real LLM reply ✓
GET  /api/messages              -> messages persisted in D1, chronological ✓
POST /api/chat/reset            -> 200, history cleared ✓
```

### Chat-specific checks (6/6)

```
context: recalls a planted fact  ✓  ("小豆漿呀 😌 剛剛才說的")
persona: does not break character ✓  ("哈哈我就是本人呀～")
persona: warm, not dismissive     ✓  ("辛苦了 😌 累的時候能撐到現在已經很好了")
D1: messages persisted + ordered  ✓  8 msgs, ordered=true
frontend: messenger markup present ✓
reset clears history               ✓
```

## ⚠️ Sender limitation (read this)

`RESEND_FROM` is `Facebook Clone <onboarding@resend.dev>`. Resend's shared test sender
can **only deliver to the email address registered on the Resend account**. Sending to
anyone else returns HTTP 422 with a clear explanation from the app.

To email real people, add a domain in the [Resend dashboard](https://resend.com/domains),
verify it (DNS records), then set:

```toml
RESEND_FROM = "Facebook Clone <noreply@yourdomain.com>"
```

and redeploy.

> **You decided not to use a custom domain**, so this limit stays as-is. The app is
> fully usable for your own account email (`howardtong2026@gmail.com`).
> If you ever change your mind, Resend's domain page has a one-click
> **"Sign in to Cloudflare"** button that writes the DNS records for you — no
> copy-pasting, and no full-access API key needed.

## Project layout

```
facebook-clone/
├── wrangler.toml            # Worker config: main, assets, vars, KV, D1
├── .dev.vars                # local secrets (gitignored)
├── public/
│   └── index.html           # entire frontend (single file, no build)
├── src/
│   └── index.js             # Worker entry — router, Resend, OAuth, sessions, chat
├── schema.sql               # D1 schema (messages + chat_sessions)
├── chat-bridge.mjs          # local bridge: OpenCode API  <->  Worker
├── chat-bridge.config.json  # bridge config (port, token, agent, model)
├── start-chat.mjs           # one command: bridge + tunnel + deploy
├── start-chat.bat           # double-click version of the above
├── setup-google.mjs         # set Google OAuth secrets + deploy
├── setup-euorg.mjs          # finish the howardtong.eu.org sending domain
├── setup-domain.mjs         # register a domain + wire Resend + deploy
└── _scaffold-unused/        # old SvelteKit files (never compiled — reference only)
```

## Features

| | |
|---|---|
| **Feed** | Posts from you + your friends, like toggle with live counts, inline comments, **search highlighted** |
| **Posts** | Create, **inline edit** (emoji row, char counter, ⌘↵ to save), delete — own posts only |
| **Mentions** | type `@` in the composer → **autocomplete dropdown**, click to insert, the person gets notified |
| **Comments** | Inline thread per post, permission-checked |
| **Profile** | Cover, **identicon avatar**, name, bio (editable), stats (posts / friends / likes) |
| **Friends** | 5 seeded NPCs (auto-friends) + **request → accept / decline** flow for real people |
| **Messages** | Thread with Mika (OpenCode agent), typing indicator, thread list, new-conversation reset |
| **Notifications** | Likes, comments, friend requests, mentions — unread badge + per-kind opt-out |
| **Search** | Server-side, people + posts, scoped to your friends, **matches highlighted** |
| **Settings** | Name/bio, notification preferences, sign out |
| **Auth** | Google OAuth 2.0 + email verification via Resend |

### Identicon avatars

Every person gets a deterministic SVG identicon, generated in the browser from a hash of
their email — no external service, no uploads. Same email → same picture, on every
device, forever.

### Friend requests

| Action | Result |
|---|---|
| `action: "request"` | creates a pending request + notifies the other person |
| `action: "accept"` | becomes friends (both directions) + notifies the requester |
| `action: "decline"` | request marked declined, no friendship |
| `action: "remove"` | unfriends + clears any pending request |

NPCs accept instantly (they're the "suggested friends" that populate a new feed).
Real users go through request → accept. The NPCs stay in `friends` directly, so a new
account has a populated feed from day one.

---

## Data isolation (per-account everything)

Every table is scoped by the signed-in user's email. The session cookie is an HMAC-signed
payload containing `userId` / `email` / `name`, so two browsers are two different accounts.

| Data | Key | Scope |
|---|---|---|
| `profiles` | `email` | one row per account, created on first sign-in |
| `posts` | `author_email` | feed query: `author = me OR author IN (my friends)` |
| `likes` | `(post_id, user_email)` | composite — your like is yours alone |
| `comments` | `user_email` | read/write guarded by `canSeePost()` |
| `friends` | `(owner_email, friend_email)` | per-account friend lists |
| `friend_requests` | `(from_email, to_email)` | pending / accepted / declined |
| `messages` | `user_email` | per-account chat history + OpenCode session |
| `notifications` | `user_email` | per-account, honours preferences |
| `settings` | `user_email` | per-account notification prefs |

`canSeePost(me, postId)` is checked before reading comments, liking, editing or deleting —
a stranger who guesses a post ID gets `403`, not the content.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | which integrations are live |
| `GET` | `/api/session` | current user |
| `POST` | `/api/logout` | clear the session |
| `POST` | `/api/send-verification` | email a verification link (guarded) |
| `GET` | `/api/verify?token=` | validate a link, sign the user in |
| `GET` | `/api/google-login` | OAuth authorize URL |
| `GET` | `/api/google-callback` | OAuth exchange |
| `GET` | `/api/feed` | posts from you + friends |
| `POST` | `/api/posts` | create a post (`@mentions` resolved) |
| `POST` | `/api/posts/edit` | edit your own post |
| `POST` | `/api/posts/delete` | delete your own post |
| `POST` | `/api/posts/like` | toggle a like |
| `GET/POST` | `/api/posts/comments` | read / write comments |
| `GET/PATCH` | `/api/profile` | your profile |
| `GET/POST` | `/api/friends` | list / toggle friends |
| `GET/POST` | `/api/notifications` | list / mark read |
| `GET` | `/api/search?q=` | people + posts |
| `GET/POST` | `/api/settings` | notification prefs + profile |
| `GET/POST` | `/api/messages` | chat history |
| `POST` | `/api/chat` | talk to Mika (via the local bridge) |
| `POST` | `/api/chat/reset` | start a new conversation |
| `GET` | `/api/threads` | conversation list |

---

## The NPC chat feature

`Mika` is an OpenCode **agent** (not a model prompt bolted on). She lives in:

```
C:\Users\user\.config\opencode\agent\mika.md
```

### Architecture

```
Browser  (public/index.html — Messenger panel)
   │  POST /api/chat
   ▼
Cloudflare Worker  ──▶  D1  (messages, chat_sessions)
   │  fetch(CHAT_BRIDGE_URL)
   ▼
cloudflared quick tunnel  (trycloudflare.com)
   ▼
chat-bridge.mjs  (127.0.0.1:8788)
   │  POST /api/session/:id/prompt
   ▼
opencode serve  →  agent "mika"  →  opencode/minimax-m3.1-flash-free
```

### Why a bridge?

The Worker runs on Cloudflare's edge and cannot reach `localhost`. The bridge is a tiny local
Node process that speaks the OpenCode v2 HTTP API; `cloudflared` gives it a public URL.
The bridge is protected by a shared secret (`CHAT_BRIDGE_TOKEN`) sent as `x-bridge-token`.

### OpenCode v2 API notes (these differ from v1)

| Action | Call |
|---|---|
| list agents | `GET /api/agent` |
| create session | `POST /api/session` → `data.id` |
| pick the agent | `POST /api/session/:id/agent` `{ agent: "mika" }` |
| pick the model | `POST /api/session/:id/model` `{ model: { id, providerID } }` |
| send a message | `POST /api/session/:id/prompt` `{ text, agents: [{ name }] }` |
| read messages | `GET /api/session/:id/message` → `data[]` |

- Auth is HTTP Basic: `opencode` + the password in
  `C:\Users\user\.local\state\opencode\service.json`
- `/api/session/:id/prompt` is **async** — it admits the message and returns immediately.
  Poll `GET /api/session/:id/message` for the assistant reply.
- Assistant messages carry `content: [{ type: "text", text }]` and a `finish` field.
  Read `content`, not `text` — the `text` field can hold in-flight reasoning.
- `POST /api/session/:id/message` (v1 style) does **not** exist in v2 → 404.

### Start / restart the chat stack

```powershell
node start-chat.mjs
```

or double-click **`start-chat.bat`**.

It stops the old bridge + tunnel, starts a new bridge, opens a fresh quick tunnel,
writes the new URL into `wrangler.toml`, refreshes the Cloudflare token, and redeploys.
**Leave the window open** — closing it stops the NPC.

### Editing Mika

Edit `C:\Users\user\.config\opencode\agent\mika.md`, then:

```powershell
opencode reload
```

No redeploy needed — the bridge picks up the new agent on the next message.

---

## Configuration

Vars live in `wrangler.toml`; secrets are set with `wrangler secret put`.

| Name | Where | Notes |
|---|---|---|
| `RESEND_API_KEY` | **secret** | from resend.com/api-keys |
| `RESEND_FROM` | var | must be on a domain verified in Resend |
| `GOOGLE_CLIENT_ID` | **secret** | Google Cloud Console → OAuth client |
| `GOOGLE_CLIENT_SECRET` | **secret** | same |
| `SESSION_SECRET` | var | random string, signs session cookies |
| `SITE_URL` | var | public URL of the Worker |
| `EXPOSE_DEV_TOKEN` | var | `"true"` returns the verify link in the API response (testing); set `"false"` in production |

## Local development

```powershell
cd "C:\Users\user\Desktop\AI學習第九課\facebook-clone"
npx wrangler dev
# → http://127.0.0.1:8787
```

`.dev.vars` is used for local secrets:

```
RESEND_API_KEY="re_xxxxxxxx"
GOOGLE_CLIENT_ID="xxxxx.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="xxxxx"
```

## Deploy

```powershell
npx wrangler deploy
```

## Google OAuth setup

1. Google Cloud Console → **APIs & Services** → **Credentials**
2. Create **OAuth client ID** → type *Web application*
3. **Authorized redirect URI**: `https://facebook-clone.howardtong2026.workers.dev/api/google-callback`
4. **Authorized JavaScript origin**: `https://facebook-clone.howardtong2026.workers.dev`
5. Copy Client ID + Client secret → put them in `C:\Users\user\Desktop\AI學習第九課\google-oauth.txt`
   (line 1 = Client ID, line 2 = Client secret), then run:
   ```powershell
   node setup-google.mjs
   ```
   The script sets both secrets, deploys, verifies `/api/google-login`, and wipes the raw
   values out of that text file.
6. Add `howardtong2026@gmail.com` as a **test user** on the OAuth consent screen — otherwise
   Google refuses the sign-in while the app is in "Testing" publishing status.

## Email verification flow

1. `POST /api/send-verification` `{ "email": "...", "name": "..." }`
2. Worker creates a UUID token, stores `{userId, email, token, expiresAt, verified:false}` in KV under `user:<email>`
3. Worker sends the email (Cloudflare `send_email` binding first, Resend as fallback)
4. Email links to `/api/verify?token=…&email=…`
5. `GET /api/verify` validates token + expiry, flips `verified: true`, sets a signed `fb_session` cookie

### Anti-spam guards

`POST /api/send-verification` refuses to send when:

| Guard | Behaviour |
|---|---|
| **Already signed in as that address** | returns `alreadySignedIn: true`, `emailSent: false` — no email |
| **Sent within the last 5 minutes** | returns `throttled: true` — no second email, reuses the existing token |

This exists because a browser can re-submit the signup form on refresh (Chrome restores
form values and focus, and implicit submission fires on Enter). The server now makes
that harmless.

### Input sanitising

User text (post bodies, comments, names, bios) is sanitised **on write** — HTML tags,
`<script>`/`<style>` blocks, `javascript:` URLs and `on*=` handlers are stripped — and
escaped again on render. Defence in depth: a future rendering path can't turn a stored
post into XSS. Angle brackets that aren't tags (`I love <3`) survive.

### Permission model

| Action | Rule |
|---|---|
| Read a post's comments | must be the author **or** a friend of the author |
| Like a post | same |
| Edit / delete a post | author only |
| Read messages | your own `user_email` only |
| Read notifications | your own `user_email` only |
| Unknown `/api/*` path | JSON `404` (not the SPA HTML) |

### Session cookies

`fb_session = base64url(json).hmac-sha256(json)` — signed with `SESSION_SECRET`,
`HttpOnly; Secure; SameSite=Lax`, 7-day max age. No server-side session table needed.

## Production checklist

- [x] `RESEND_API_KEY` set as a secret
- [ ] `RESEND_FROM` points at a **verified** Resend domain (currently `onboarding@resend.dev`, account email only)
- [ ] `EXPOSE_DEV_TOKEN` set to `"false"`
- [x] `SESSION_SECRET` set to a random value
- [ ] Google OAuth credentials set (if Google sign-in is wanted)
- [ ] Rate limiting on `/api/send-verification` (or Resend will rate-limit for you)
- [ ] Real user persistence — KV keys expire in 30 days; move to D1 for durability
- [ ] Add a password-based login path (currently login = "email me a sign-in link")
