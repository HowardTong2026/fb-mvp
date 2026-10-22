/**
 * chat-bridge.mjs — local bridge between the Cloudflare Worker and OpenCode.
 *
 *   Browser  ->  Cloudflare Worker  ->  (cloudflared tunnel)  ->  THIS  ->  opencode serve
 *
 * Endpoints
 *   GET  /health          -> { ok, agent, model, sessions }
 *   POST /chat            -> { sessionId, text }  =>  { ok, sessionId, reply, ms }
 *   POST /reset           -> { sessionId }         =>  { ok }
 *   GET  /session/:id     -> { ok, messages[] }
 *
 * Auth: every request (except /health) must send  x-bridge-token: <BRIDGE_TOKEN>
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// config lives next to this script — avoids env-var quoting problems on Windows
const CFG = JSON.parse(readFileSync(join(HERE, 'chat-bridge.config.json'), 'utf8'));

const PORT = Number(process.env.BRIDGE_PORT || CFG.port || 8788);
const TOKEN = CFG.token || '';
const AGENT = CFG.agent || 'mika';
const MODEL_ID = CFG.model || 'minimax-m3.1-flash-free';
const PROVIDER = CFG.provider || 'opencode';
const SERVICE_JSON =
  CFG.opencodeServiceJson || 'C:/Users/user/.local/state/opencode/service.json';

/* ---------- opencode client ---------- */
let oc = null;
function opencode() {
  if (oc) return oc;
  const svc = JSON.parse(readFileSync(SERVICE_JSON, "utf8"));
  oc = {
    url: svc.url,
    headers: {
      authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64"),
      "content-type": "application/json",
    },
  };
  return oc;
}

async function ocFetch(path, method = "GET", body) {
  const c = opencode();
  const res = await fetch(c.url + path, {
    method,
    headers: c.headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    throw new Error(`opencode ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return json?.data ?? json;
}

/* ---------- session helpers ---------- */
// One OpenCode session per (user, NPC) so each conversation keeps its own context.
const sessions = new Map();   // "user|peer" -> session id

async function createSession(agent) {
  const s = await ocFetch("/api/session", "POST", { title: `Facebook Clone — ${agent}` });
  const id = s.id;
  await ocFetch(`/api/session/${id}/agent`, "POST", { agent });
  await ocFetch(`/api/session/${id}/model`, "POST", { model: { id: MODEL_ID, providerID: PROVIDER } });
  return id;
}

async function sessionFor(user, agent) {
  const key = `${user || "anon"}|${agent}`;
  const hit = sessions.get(key);
  if (hit) return hit;
  const id = await createSession(agent);
  sessions.set(key, id);
  return id;
}

/** Make sure the session is currently using the right agent. */
async function ensureAgent(sid, agent) {
  try { await ocFetch(`/api/session/${sid}/agent`, "POST", { agent }); } catch {}
}

function extractText(msg) {
  if (!msg) return "";
  // Completed messages carry `content: [{type:"text", text}]`.
  // Prefer it: the `text` field can hold in-flight reasoning.
  if (Array.isArray(msg.content)) {
    const t = msg.content
      .filter((c) => !c.type || c.type === "text")
      .map((c) => c.text || "")
      .join("")
      .trim();
    if (t) return t;
  }
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
  if (msg.payload?.text) return String(msg.payload.text);
  return "";
}

async function listMessages(sid) {
  const data = await ocFetch(`/api/session/${sid}/message`);
  return Array.isArray(data) ? data : (data?.data ?? []);
}

/** Wait for a NEW assistant reply (ignores replies from earlier turns). */
async function waitForReply(sid, knownIds, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1200));
    const msgs = await listMessages(sid);
    for (const m of msgs) {
      if (m.type !== "assistant") continue;
      if (knownIds.has(m.id)) continue;          // already seen
      if (m.error) {
        return {
          reply: null,
          error:
            m.error?.message ||
            m.error?.data?.message ||
            m.error?.name ||
            JSON.stringify(m.error).slice(0, 300),
        };
      }
      if (!m.finish) continue;                  // still streaming
      const t = extractText(m);
      if (t) return { reply: t, error: null };
    }
  }
  return { reply: null, error: "Timed out waiting for the model." };
}

/* ---------- http server ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const send = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-bridge-token",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(s);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return send(res, 204, {});

  if (path === "/health") {
    try {
      const agents = await ocFetch("/api/agent");
      const list = agents?.data ?? agents ?? [];
      return send(res, 200, {
        ok: true,
        agent: AGENT,
        model: `${PROVIDER}/${MODEL_ID}`,
        opencode: opencode().url,
        agents: list.map((a) => a.name),
        openSessions: sessions.size,
      });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e.message) });
    }
  }

  // token check
  if (TOKEN) {
    const got = req.headers["x-bridge-token"];
    if (got !== TOKEN) return send(res, 401, { ok: false, error: "bad bridge token" });
  }

  try {
    if (path === "/chat" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return send(res, 400, { ok: false, error: "text required" });
      if (text.length > 4000) return send(res, 400, { ok: false, error: "text too long" });

      const agent = String(body.agent || AGENT).trim().toLowerCase();
      const user = String(body.user || "anon").trim();

      const t0 = Date.now();
      let sid = body.sessionId;
      if (!sid) sid = await sessionFor(user, agent);
      else await ensureAgent(sid, agent);

      // snapshot existing messages so we only accept a NEW reply
      const before = await listMessages(sid);
      const knownIds = new Set(before.map((m) => m.id));

      await ocFetch(`/api/session/${sid}/prompt`, "POST", {
        text,
        agents: [{ name: agent }],
      });

      const { reply, error } = await waitForReply(sid, knownIds);
      if (!reply) {
        return send(res, 502, { ok: false, error: error || "no reply", sessionId: sid, agent });
      }
      return send(res, 200, { ok: true, sessionId: sid, agent, reply, ms: Date.now() - t0 });
    }

    if (path === "/reset" && req.method === "POST") {
      const body = await readBody(req);
      if (body.sessionId) {
        try { await ocFetch(`/api/session/${body.sessionId}`, "DELETE"); } catch {}
      }
      if (body.user && body.agent) sessions.delete(`${body.user}|${body.agent}`);
      return send(res, 200, { ok: true });
    }

    if (path.startsWith("/session/") && req.method === "GET") {
      const sid = path.split("/").pop();
      const msgs = await listMessages(sid);
      return send(res, 200, { ok: true, messages: msgs });
    }

    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`chat-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`  agent = ${AGENT}   model = ${PROVIDER}/${MODEL_ID}`);
  console.log(`  token = ${TOKEN ? "required" : "NOT SET (open)"}`);
});
