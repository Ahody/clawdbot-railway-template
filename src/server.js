import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pg from "pg";
import * as tar from "tar";

// Migrate deprecated CLAWDBOT_* env vars → OPENCLAW_* so existing Railway deployments
// keep working. Users should update their Railway Variables to use the new names.
for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const oldKey = `CLAWDBOT_${suffix}`;
  const newKey = `OPENCLAW_${suffix}`;
  if (process.env[oldKey] && !process.env[newKey]) {
    process.env[newKey] = process.env[oldKey];
    // Best-effort compatibility shim for old Railway templates.
    // Intentionally no warning: Railway templates can still set legacy keys and warnings are noisy.
  }
  // Avoid forwarding legacy variables into OpenClaw subprocesses.
  // OpenClaw logs a warning when deprecated CLAWDBOT_* variables are present.
  delete process.env[oldKey];
}

// Railway injects PORT at runtime and routes traffic to that port.
// Do not force a different public port in the container image, or the service may
// boot but the Railway domain will be routed to a different port.
//
// OPENCLAW_PUBLIC_PORT is kept as an escape hatch for non-Railway deployments.
const PORT = Number.parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];

  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Default to canonical even if it doesn't exist yet.
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

// One-time migration: rename legacy config files to openclaw.json so existing
// deployments that still have the old filename on their volume keep working.
(function migrateLegacyConfigFile() {
  // If the operator explicitly chose a config path, do not rename files in STATE_DIR.
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return;

  const canonical = path.join(STATE_DIR, "openclaw.json");
  if (fs.existsSync(canonical)) return;

  for (const legacy of ["clawdbot.json", "moltbot.json"]) {
    const legacyPath = path.join(STATE_DIR, legacy);
    try {
      if (fs.existsSync(legacyPath)) {
        fs.renameSync(legacyPath, canonical);
        console.log(`[migration] Renamed ${legacy} → openclaw.json`);
        return;
      }
    } catch (err) {
      console.warn(`[migration] Failed to rename ${legacy}: ${err}`);
    }
  }
})();

let gatewayProc = null;
let gatewayStarting = null;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Try the default Control UI base path, then fall back to root.
      const paths = ["/openclaw", "/"];
      for (const p of paths) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          // Any HTTP response means the port is open.
          if (res) return true;
        } catch {
          // try next
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString() };
    gatewayProc = null;
  });
}

async function runDoctorBestEffort() {
  // Avoid spamming `openclaw doctor` in a crash loop.
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;

  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({
          timeoutMs: Number.parseInt(process.env.GATEWAY_READY_TIMEOUT_MS ?? "90000", 10) || 90_000,
        });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        lastGatewayError = msg;
        // Collect extra diagnostics to help users file issues.
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

async function probeGateway() {
  // Don't assume HTTP — the gateway primarily speaks WebSocket.
  // A simple TCP connect check is enough for "is it up".
  const net = await import("node:net");

  return await new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });

    const done = (ok) => {
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

// Public health endpoint (no auth) so Railway can probe without /setup.
// Keep this free of secrets.
app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured()) {
    try {
      gatewayReachable = await probeGateway();
    } catch {
      gatewayReachable = false;
    }
  }

  res.json({
    ok: true,
    wrapper: {
      configured: isConfigured(),
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
    },
    gateway: {
      target: GATEWAY_TARGET,
      reachable: gatewayReachable,
      lastError: lastGatewayError,
      lastExit: lastGatewayExit,
      lastDoctorAt,
    },
  });
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup">
      <option>Loading providers…</option>
    </select>

    <label>Auth method</label>
    <select id="authChoice">
      <option>Loading methods…</option>
    </select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>2b) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for “disconnected (1008): pairing required”)</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

const AUTH_GROUPS = [
  { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
    { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
    { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
    { value: "openai-api-key", label: "OpenAI API key" }
  ]},
  { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
    { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
    { value: "token", label: "Anthropic token (paste setup-token)" },
    { value: "apiKey", label: "Anthropic API key" }
  ]},
  { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
    { value: "gemini-api-key", label: "Google Gemini API key" },
    { value: "google-antigravity", label: "Google Antigravity OAuth" },
    { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
  ]},
  { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
    { value: "openrouter-api-key", label: "OpenRouter API key" }
  ]},
  { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
    { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
  ]},
  { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
    { value: "moonshot-api-key", label: "Moonshot AI API key" },
    { value: "kimi-code-api-key", label: "Kimi Code API key" }
  ]},
  { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
    { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
  ]},
  { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
    { value: "minimax-api", label: "MiniMax M2.1" },
    { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
  ]},
  { value: "qwen", label: "Qwen", hint: "OAuth", options: [
    { value: "qwen-portal", label: "Qwen OAuth" }
  ]},
  { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
    { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
    { value: "copilot-proxy", label: "Copilot Proxy (local)" }
  ]},
  { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
    { value: "synthetic-api-key", label: "Synthetic API key" }
  ]},
  { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
    { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
  ]}
];

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups: AUTH_GROUPS,
  });
});

app.get("/setup/api/auth-groups", requireSetupAuth, (_req, res) => {
  res.json({ ok: true, authGroups: AUTH_GROUPS });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };

    const flag = map[payload.authChoice];

    // If the user picked an API-key auth choice but didn't provide a secret, fail fast.
    // Otherwise OpenClaw may fall back to its default auth choice, which looks like the
    // wizard "reverted" their selection.
    if (flag && !secret) {
      throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    }

    if (flag) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token") {
      // This is the Anthropic setup-token flow.
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120_000;

    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    let killTimer;
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2_000);
      out += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;
      resolve({ code: 124, output: out });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 0, output: out });
    });
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const respondJson = (status, body) => {
      if (res.writableEnded || res.headersSent) return;
      res.status(status).json(body);
    };
    if (isConfigured()) {
      await ensureGatewayRunning();
      return respondJson(200, {
        ok: true,
        output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return respondJson(400, { ok: false, output: `Setup input error: ${String(err)}` });
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional setup (only after successful onboarding).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    // IMPORTANT: Set both gateway.auth.token (server-side) and gateway.remote.token (client-side)
    // to the same value so the Control UI can connect without "token mismatch" errors.
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Railway runs behind a reverse proxy. Trust loopback as a proxy hop so local client detection
    // remains correct when X-Forwarded-* headers are present.
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"]) ]),
    );

    // Optional: configure a custom OpenAI-compatible provider (base URL) for advanced users.
    if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
      const providerId = payload.customProviderId.trim();
      const baseUrl = payload.customProviderBaseUrl.trim();
      const api = (payload.customProviderApi || "openai-completions").trim();
      const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
      const modelId = (payload.customProviderModelId || "").trim();

      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
        extra += `\n[custom provider] skipped: invalid provider id (use letters/numbers/_/-)`;
      } else if (!/^https?:\/\//.test(baseUrl)) {
        extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
      } else if (api !== "openai-completions" && api !== "openai-responses") {
        extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
      } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        extra += `\n[custom provider] skipped: invalid api key env var name`;
      } else {
        const providerCfg = {
          baseUrl,
          api,
          apiKey: apiKeyEnv ? "${" + apiKeyEnv + "}" : undefined,
          models: modelId ? [{ id: modelId, name: modelId }] : undefined,
        };

        // Ensure we merge in this provider rather than replacing other providers.
        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
        );
        extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
      }
    }

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));

        // Best-effort: enable the telegram plugin explicitly (some builds require this even when configured).
        const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));

        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        extra += `\n[telegram plugin enable] exit=${plug.code} (output ${plug.output.length} chars)\n${plug.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
    extra += `\n[doctor --fix] exit=${fix.code} (output ${fix.output.length} chars)\n${fix.output || "(no output)"}`;

    // Doctor may require a restart depending on changes.
    await restartGateway();
  }

  return respondJson(ok ? 200 : 500, {
    ok,
    output: `${prefix}${onboard.output}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return respondJson(500, { ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  // Channel config checks (redact secrets before returning to client)
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  const tgOut = redactSecrets(tg.output || "");
  const dcOut = redactSecrets(dc.output || "");

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      configPathResolved: configPath(),
      configPathCandidates: typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : null,
      internalGatewayHost: INTERNAL_GATEWAY_HOST,
      internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET,
      gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output || "") || /enabled\s*[:=]\s*true/.test(tg.output || ""),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output || ""),
          output: tgOut,
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output || "") || /enabled\s*[:=]\s*true/.test(dc.output || ""),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output || "") || /token\s*[:=]\s*\S+/.test(dc.output || ""),
          output: dcOut,
        },
      },
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    // Telegram bot tokens look like: 123456:ABCDEF...
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();

  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);

  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",

  // Device management (for fixing "disconnected (1008): pairing required")
  "openclaw.devices.list",
  "openclaw.devices.approve",

  // Plugin management
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Device management commands (for fixing "disconnected (1008): pairing required")
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      const requestId = String(arg || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "Missing device request ID" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Plugin management commands
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      const name = String(arg || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "Missing plugin name" });
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", name]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// Device pairing helper (list + approve) to avoid needing SSH.
app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "Missing device request ID" });
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Reset: stop gateway (frees memory) + delete config file(s) so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    // Stop gateway to avoid running gateway + onboard concurrently on small Railway instances.
    try {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
    } catch {
      // ignore
    }

    const candidates = typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : [configPath()];
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }

    res.type("text/plain").send("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err);
  try {
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Gateway unavailable\n");
    }
  } catch {
    // ignore
  }
});

// --- Dashboard password protection ---
// Require the same SETUP_PASSWORD for the entire Control UI dashboard,
// not just the /setup routes.  Healthcheck is excluded so Railway probes work.
function requireDashboardAuth(req, res, next) {
  if (req.path === "/healthz" || req.path === "/setup/healthz") return next();
  if (req.path.startsWith("/hooks")) return next(); // allow OpenClaw webhook endpoints to bypass dashboard auth
  if (!SETUP_PASSWORD) return next(); // no password configured → open
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Dashboard"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Dashboard"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

// --- Gateway token injection ---
// The gateway is only reachable from this container. The Control UI in the browser
// cannot set custom Authorization headers for WebSocket connections, so we inject
// the token into proxied requests at the wrapper level.
function attachGatewayAuthHeader(req) {
  if (!req?.headers?.authorization && OPENCLAW_GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
  }
}

proxy.on("proxyReqWs", (_proxyReq, req) => {
  attachGatewayAuthHeader(req);
});

// --- Log ingest (Supabase/Railway "Custom Endpoint" drain) → logs Postgres ---
// Receives log batches over HTTP, redacts sensitive data (SOC2/GDPR/ISO27001), and writes them
// to the logs DB that Kent reads (read-only via kent_logs_reader) for ops triage.
//   LOGS_DB_WRITE_URL   write connection to the logs Postgres (creates table + inserts)
//   LOGS_INGEST_TOKEN   shared secret required as Authorization: Bearer <token>
let logsPool = null;
function getLogsPool() {
  if (!process.env.LOGS_DB_WRITE_URL?.trim()) return null;
  if (!logsPool) {
    logsPool = new pg.Pool({
      connectionString: process.env.LOGS_DB_WRITE_URL.trim(),
      ssl: { rejectUnauthorized: false },
      max: 4,
    });
    logsPool.on("error", (e) => console.warn("[logs-ingest] pool error:", String(e)));
  }
  return logsPool;
}

async function ensureLogsTable() {
  const pool = getLogsPool();
  if (!pool) return;
  try {
    await pool.query(`create table if not exists public.ingested_logs (
        id bigserial primary key,
        received_at timestamptz not null default now(),
        source text,
        log_timestamp timestamptz,
        level text,
        message text,
        meta jsonb)`);
    await pool.query(`create index if not exists ingested_logs_received_at_idx on public.ingested_logs (received_at desc)`);
    console.log("[logs-ingest] logs table ready");
  } catch (err) {
    console.warn(`[logs-ingest] ensure table failed: ${String(err)}`);
  }
}

function extractLogEvents(body) {
  if (Array.isArray(body)) return body;
  for (const k of ["events", "logs", "data", "result", "records"]) if (Array.isArray(body?.[k])) return body[k];
  if (body && typeof body === "object") return [body];
  return [];
}

function pickLogTs(ev) {
  const t = ev.timestamp ?? ev.time ?? ev.log_timestamp ?? ev.ts;
  if (t == null) return null;
  if (typeof t === "number") {
    const ms = t > 1e15 ? t / 1000 : t > 1e12 ? t : t * 1000;
    try { return new Date(ms).toISOString(); } catch { return null; }
  }
  return String(t).slice(0, 64);
}

app.post("/ingest/logs", express.json({ limit: "5mb" }), async (req, res) => {
  const token = process.env.LOGS_INGEST_TOKEN?.trim();
  if (!token || (req.headers.authorization || "") !== `Bearer ${token}`) {
    return res.status(401).type("text/plain").send("unauthorized");
  }
  const pool = getLogsPool();
  if (!pool) return res.status(503).type("text/plain").send("logs DB not configured");

  const source = String(req.query.source || req.headers["x-log-source"] || "supabase").slice(0, 64);
  const events = extractLogEvents(req.body);
  if (!events.length) {
    console.log("[logs-ingest] empty batch; body keys:", Object.keys(req.body || {}).join(","));
    return res.status(204).end();
  }

  let inserted = 0;
  try {
    for (const ev of events) {
      const message = redactSensitive(ev.event_message ?? ev.message ?? ev.msg ?? (typeof ev === "string" ? ev : "")).slice(0, 8000);
      const level = String(ev.level ?? ev.metadata?.level ?? ev.severity ?? "").slice(0, 32) || null;
      let meta = null;
      const metaRaw = ev.metadata ?? ev.meta ?? null;
      if (metaRaw) { try { meta = JSON.parse(redactSensitive(JSON.stringify(metaRaw))); } catch { meta = null; } }
      await pool.query(
        `insert into public.ingested_logs (source, log_timestamp, level, message, meta) values ($1,$2,$3,$4,$5)`,
        [source, pickLogTs(ev), level, message, meta],
      );
      inserted++;
    }
    res.status(200).type("text/plain").send(`ok ${inserted}`);
  } catch (err) {
    console.warn(`[logs-ingest] insert failed: ${String(err)}`);
    res.status(500).type("text/plain").send("insert error");
  }
});

app.use(requireDashboardAuth, async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.",
        String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return res.status(503).type("text/plain").send(hint);
    }
  }

  attachGatewayAuthHeader(req);
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// Optionally register an Azure OpenAI (Azure AI Foundry) provider from environment
// variables, so the template is reproducible: set the Railway variables below and the
// provider (and optionally the default agent model) is configured on every boot,
// idempotently. No secrets are written to the repo — the API key is referenced from the
// env var by name (${AZURE_OPENAI_API_KEY}) and resolved by OpenClaw at runtime.
//
//   AZURE_OPENAI_API_KEY        (required) the Azure key (kept only as a Railway variable)
//   AZURE_OPENAI_DEPLOYMENT     (required) deployment name; used as the model id
//   AZURE_OPENAI_RESOURCE       resource name -> https://<resource>.openai.azure.com/openai/v1/
//   AZURE_OPENAI_BASE_URL       optional: override the full base URL instead of RESOURCE
//   AZURE_OPENAI_API            optional: "openai-completions" (default) or "openai-responses"
//   AZURE_OPENAI_CONTEXT_WINDOW optional: integer (default 128000)
//   AZURE_OPENAI_MAX_TOKENS     optional: integer (default 16384)
//   AZURE_OPENAI_PROVIDER_ID    optional: provider id (default "azure")
//   AZURE_OPENAI_SET_DEFAULT    optional: "0"/"false" to NOT set the default model (default on)
async function ensureAzureProvider() {
  const key = process.env.AZURE_OPENAI_API_KEY?.trim();
  const resource = process.env.AZURE_OPENAI_RESOURCE?.trim();
  const baseUrlOverride = process.env.AZURE_OPENAI_BASE_URL?.trim();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT?.trim();

  // Only act when the operator has opted in via env. If none of these are set, do nothing.
  if (!key && !resource && !baseUrlOverride && !deployment) return;

  if (!deployment) {
    console.warn("[wrapper] Azure: AZURE_OPENAI_DEPLOYMENT not set; skipping Azure provider setup");
    return;
  }
  const baseUrl =
    baseUrlOverride || (resource ? `https://${resource}.openai.azure.com/openai/v1/` : "");
  if (!baseUrl) {
    console.warn("[wrapper] Azure: set AZURE_OPENAI_RESOURCE or AZURE_OPENAI_BASE_URL; skipping Azure provider setup");
    return;
  }
  if (!key) {
    console.warn("[wrapper] Azure: AZURE_OPENAI_API_KEY not set; skipping Azure provider setup");
    return;
  }

  const providerId = (process.env.AZURE_OPENAI_PROVIDER_ID?.trim() || "azure").replace(/[^A-Za-z0-9_-]/g, "");
  const api = process.env.AZURE_OPENAI_API?.trim() === "openai-responses" ? "openai-responses" : "openai-completions";
  const contextWindow = Number.parseInt(process.env.AZURE_OPENAI_CONTEXT_WINDOW ?? "128000", 10) || 128000;
  const maxTokens = Number.parseInt(process.env.AZURE_OPENAI_MAX_TOKENS ?? "16384", 10) || 16384;
  const setDefaultRaw = (process.env.AZURE_OPENAI_SET_DEFAULT ?? "1").trim().toLowerCase();
  const setDefault = !["0", "false", "no"].includes(setDefaultRaw);

  // Auth method. Azure's data plane expects the static key in the `api-key` header;
  // standard OpenAI clients send `Authorization: Bearer`. Default to "api-key" because
  // that is what Azure AI Foundry / Azure OpenAI resources accept reliably. Set
  // AZURE_OPENAI_AUTH=bearer to use Authorization: Bearer instead.
  const authMode = process.env.AZURE_OPENAI_AUTH?.trim().toLowerCase() || "api-key";
  const useApiKeyHeader = authMode === "api-key" || authMode === "apikey";

  const providerCfg = {
    baseUrl,
    api,
    // The secret is referenced by env-var name so it is never written into the config file.
    // Always set apiKey: OpenClaw uses it to register that the provider has a credential
    // (its per-agent auth check fails with "No API key found for provider" otherwise).
    apiKey: "${AZURE_OPENAI_API_KEY}",
    models: [{ id: deployment, name: deployment, contextWindow, maxTokens }],
  };
  // Azure's data plane authenticates via the `api-key` header. Also send the key there so
  // the request is accepted (OpenClaw additionally sends Authorization: Bearer from apiKey,
  // which Azure ignores when a valid api-key header is present).
  if (useApiKeyHeader) {
    providerCfg.headers = { "api-key": "${AZURE_OPENAI_API_KEY}" };
  }

  console.log(
    `[wrapper] Azure: configuring provider "${providerId}" -> ${baseUrl} (model: ${deployment}, api: ${api}, auth: ${useApiKeyHeader ? "api-key header" : "bearer"})`,
  );
  try {
    // Merge so we don't clobber other providers (Anthropic/OpenAI/etc.).
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
    );
    if (setDefault) {
      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "agents.defaults.model.primary", `${providerId}/${deployment}`]),
      );
    }
    console.log(
      `[wrapper] Azure: provider configured${setDefault ? ` and set as default model (${providerId}/${deployment})` : ""}`,
    );
  } catch (err) {
    console.warn(`[wrapper] Azure: failed to configure provider (continuing): ${String(err)}`);
  }
}

// Configure git to authenticate to GitHub as the GitHub App, so the code agent (EVA) can
// clone/push/open PRs without a human token. Env-driven and idempotent:
//   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY (PEM) — required
//   GITHUB_APP_BOT_NAME / GITHUB_APP_BOT_EMAIL — optional commit identity overrides
// The actual token minting happens in src/github-credential-helper.mjs (called by git).
async function ensureGitHubAppAuth() {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  // Only act when the operator has opted in via env.
  if (!appId && !installationId && !privateKey) return;
  if (!appId || !installationId || !privateKey) {
    console.warn("[wrapper] GitHub App: need GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY; skipping git auth setup");
    return;
  }

  const helperPath = path.join(process.cwd(), "src", "github-credential-helper.mjs");
  const botName = process.env.GITHUB_APP_BOT_NAME?.trim() || "ahody-agent[bot]";
  const botEmail = process.env.GITHUB_APP_BOT_EMAIL?.trim() || `${appId}+ahody-agent[bot]@users.noreply.github.com`;

  console.log("[wrapper] GitHub App: configuring git credential helper for github.com");
  try {
    // Route github.com auth through our token-minting helper (the leading "!" runs it as a command).
    await runCmd("git", ["config", "--global", "credential.https://github.com.helper", `!node ${helperPath}`]);
    await runCmd("git", ["config", "--global", "credential.https://github.com.useHttpPath", "false"]);
    await runCmd("git", ["config", "--global", "user.name", botName]);
    await runCmd("git", ["config", "--global", "user.email", botEmail]);
    console.log(`[wrapper] GitHub App: git configured (commits authored by ${botName})`);
  } catch (err) {
    console.warn(`[wrapper] GitHub App: failed to configure git (continuing): ${String(err)}`);
  }
}

// BugSink → Kent incident poller (Variant B). Polls the BugSink read API for new issues and
// hands them to the Kent agent, who triages and delivers ONLY what matters to a Slack incident
// channel (so not every error floods the channel). Env-driven and idempotent:
//   BUGSINK_URL, BUGSINK_API_TOKEN   (required to enable)
//   BUGSINK_PROJECTS                 comma-separated project ids to watch, e.g. "1,2" (prod+staging)
//   INCIDENT_SLACK_TARGET            OpenClaw delivery target, e.g. "channel:C0XXXXXXX"
//   BUGSINK_KENT_AGENT               agent id to triage (default "kent")
//   BUGSINK_POLL_INTERVAL_MS         default 300000 (5 min)
// Redact sensitive data (tokens, emails, PII, ID numbers) before it reaches Kent or Slack.
// Compliance backstop (SOC2/GDPR/ISO27001) — the primary scrubbing happens at the source SDK,
// this ensures nothing sensitive propagates downstream even if it slipped into an error value.
function redactSensitive(s) {
  return String(s || "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/\b(?:sbp|sb_secret|sb_publishable|sb)_[A-Za-z0-9_-]{8,}/g, "[supabase-key]")
    .replace(/\bgh[posur]_[A-Za-z0-9]{20,}/gi, "[gh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b\d{6,8}[-+]?\d{4}\b/g, "[pnr/orgnr]")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[secret]");
}

// Normalize a BugSink issue into a stable signature so the same logical error — even across
// separate issue ids (messages that differ only by a number/uuid/timestamp/test marker) — is
// reported once and not re-spammed.
function bugsinkSignature(iss) {
  const v = String(iss.calculated_value || "")
    .toLowerCase()
    .replace(/\[test#[^\]]*\]/g, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.z+-]+/gi, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return `${iss.calculated_type || ""}::${v}`;
}

// Fetch open (non-completed/canceled) Linear issues for the configured team, so Kent can link an
// existing issue instead of proposing a duplicate. Read-only GraphQL — never writes to Linear.
//   LINEAR_API_KEY (personal API key), LINEAR_TEAM_ID
async function fetchLinearOpenIssues() {
  const key = process.env.LINEAR_API_KEY?.trim();
  const teamId = process.env.LINEAR_TEAM_ID?.trim();
  if (!key || !teamId) return [];
  const query = `query($teamId: String!) {
    team(id: $teamId) {
      issues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { id identifier title url }
      }
    }
  }`;
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables: { teamId } }),
    });
    if (!res.ok) { console.warn(`[bugsink-poll] Linear HTTP ${res.status}`); return []; }
    const data = await res.json();
    if (data?.errors) { console.warn(`[bugsink-poll] Linear errors: ${JSON.stringify(data.errors).slice(0, 300)}`); return []; }
    return data?.data?.team?.issues?.nodes || [];
  } catch (err) {
    console.warn(`[bugsink-poll] Linear fetch failed: ${String(err)}`);
    return [];
  }
}

// Resolve Sentry-style tags (array of [k,v], array of {key,value}, or object) into a flat map.
function normalizeTags(t) {
  const out = {};
  if (Array.isArray(t)) {
    for (const e of t) {
      if (Array.isArray(e)) out[e[0]] = e[1];
      else if (e && e.key !== undefined) out[e.key] = e.value;
    }
  } else if (t && typeof t === "object") {
    Object.assign(out, t);
  }
  return out;
}

// Fetch the latest event for an issue and derive WHERE the error lives (db/edge/frontend/api)
// + the route/transaction, so Kent triages with source context and matches Linear better.
async function fetchIssueContext(base, token, issueId) {
  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const listRes = await fetch(`${base}/api/canonical/0/events/?issue=${encodeURIComponent(issueId)}`, { headers });
    if (!listRes.ok) return null;
    const results = (await listRes.json())?.results || [];
    const evId = results.length ? results[results.length - 1].id || results[0].id : null;
    if (!evId) return null;
    const evRes = await fetch(`${base}/api/canonical/0/events/${encodeURIComponent(evId)}/`, { headers });
    if (!evRes.ok) return null;
    const data = (await evRes.json())?.data || {};
    const tags = normalizeTags(data.tags);
    const server = tags.server_name;
    let source = tags.source;
    if (!source && server) source = server === "supabase-edge" ? "edge" : server === "supabase-db" ? "db" : server;
    if (!source && tags.service) source = `api:${tags.service}`;
    if (!source && data.platform === "javascript") source = "frontend";
    if (!source) source = data.platform || null;
    return {
      source,
      transaction: data.transaction || tags.function || null,
      url: data.request?.url || null,
      environment: data.environment || tags.environment || null,
    };
  } catch {
    return null;
  }
}

function ctxLabel(ctx) {
  if (!ctx || !ctx.source) return "";
  const where = ctx.transaction || ctx.url;
  const w = where ? " " + redactSensitive(String(where)).replace(/^https?:\/\/[^/]+/, "").slice(0, 60) : "";
  return `[${ctx.source}${w}]`;
}

async function pollBugsinkOnce() {
  const url = process.env.BUGSINK_URL?.trim();
  const token = process.env.BUGSINK_API_TOKEN?.trim();
  const projects = (process.env.BUGSINK_PROJECTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const target = process.env.INCIDENT_SLACK_TARGET?.trim();
  if (!url || !token || !projects.length || !target) return;
  const agentId = process.env.BUGSINK_KENT_AGENT?.trim() || "kent";

  // Dedupe by error signature (not raw issue id) so duplicates of the same problem don't spam.
  const statePath = path.join(STATE_DIR, "bugsink-seen-v2.json");
  const firstRun = !fs.existsSync(statePath);
  let seen;
  try { seen = new Set(JSON.parse(fs.readFileSync(statePath, "utf8"))); } catch { seen = new Set(); }

  const fresh = [];
  for (const pid of projects) {
    try {
      const res = await fetch(`${url}/api/canonical/0/issues/?project=${encodeURIComponent(pid)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) { console.warn(`[bugsink-poll] project ${pid}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      for (const iss of data?.results || []) {
        if (iss.is_resolved || iss.is_muted) continue;
        const signature = bugsinkSignature(iss);
        if (iss.id && !seen.has(signature)) {
          seen.add(signature);
          fresh.push({
            project: pid,
            uuid: iss.id,
            friendly: iss.friendly_id || iss.id,
            type: iss.calculated_type,
            value: iss.calculated_value,
            events: iss.stored_event_count,
            last_seen: iss.last_seen,
          });
        }
      }
    } catch (err) { console.warn(`[bugsink-poll] project ${pid}: ${String(err)}`); }
  }

  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify([...seen])); } catch {}

  // First run: seed the seen-set from existing issues but do NOT escalate the backlog.
  if (firstRun) { console.log(`[bugsink-poll] seeded ${seen.size} existing issue(s); escalation starts on next new issue`); return; }
  if (!fresh.length) return;

  // BugSink issue web-URL (override the format with BUGSINK_ISSUE_URL_TEMPLATE if it differs).
  const base = url.replace(/\/$/, "");
  const urlTmpl = process.env.BUGSINK_ISSUE_URL_TEMPLATE?.trim() || `${base}/issues/issue/{id}/event/last/`;
  const linkFor = (f) => urlTmpl.replace("{id}", f.uuid).replace("{project}", String(f.project)).replace("{friendly}", f.friendly);

  // Enrich each issue with source context (db/edge/frontend/api + route) from its latest event.
  await Promise.all(fresh.map(async (f) => { f.ctx = await fetchIssueContext(base, token, f.uuid); }));

  const lines = fresh.map((f) => `- ${ctxLabel(f.ctx)} ${f.friendly} ${f.type}: ${redactSensitive(f.value)} (${f.events} events) → ${linkFor(f)}`.replace(/^- {2}/, "- ")).join("\n");

  const linearOpen = await fetchLinearOpenIssues();
  const linearList = linearOpen.length
    ? linearOpen.map((i) => `- ${i.identifier}: ${i.title} (${i.url})`).join("\n")
    : "(inga öppna Linear-issues hämtade)";

  const prompt = [
    "Nya BugSink-issues upptäckta:",
    lines,
    "",
    "Öppna Linear-issues just nu (team AHO):",
    linearList,
    "",
    "Du är Kent, drift-agent. Svara på REN SVENSKA.",
    "Bedöm allvar och ignorera brus/smoke-tester. Skriv INGENTING om inget behöver göras.",
    "Käll-taggen i hakparentes ([db]/[edge]/[frontend]/[api:...] + route) visar var felet ligger — använd den i triagen och för att matcha rätt Linear-issue.",
    "Om flera issues i listan har samma grundorsak: slå ihop dem till EN incident, inte flera.",
    "Om en BugSink-issue matchar en BEFINTLIG öppen Linear-issue ovan: länka den (identifier + URL) istället för att föreslå en ny.",
    "Om ingen matchar: skriv att en ny Linear-issue kan skapas genom 👍 eller svaret 'skapa' i tråden (skapa INTE själv — det sker automatiskt efter mänskligt godkännande).",
    "Om minst en issue är viktig: skriv ett kort incident-meddelande på svenska med BugSink-länken,",
    "och placera HELA meddelandet mellan markörerna <<<POST>>> och <<<END>>>.",
    "Använd BugSink-länkarna EXAKT som de står ovan — ändra eller förkorta dem inte.",
    "Inkludera ALDRIG personuppgifter, e-post, tokens, nycklar eller företags-/kunddata i meddelandet (SOC2/GDPR/ISO27001).",
    "Om inget är viktigt: svara med ENBART <<<SKIP>>> och inget annat.",
  ].join("\n");

  console.log(`[bugsink-poll] ${fresh.length} new issue(s) → triaging with agent "${agentId}"`);
  let out = "";
  try {
    // NOTE: verify flags against `openclaw agent --help` (no --deliver: we capture the reply).
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["agent", "--agent", agentId, "--message", prompt]), { timeoutMs: 180_000 });
    out = r.output || "";
  } catch (err) {
    console.warn(`[bugsink-poll] triage failed: ${String(err)}`);
    return;
  }

  // Stay silent unless Kent produced a message between the markers.
  if (/<<<SKIP>>>/.test(out) || !/<<<POST>>>/.test(out)) {
    console.log("[bugsink-poll] Kent: no action needed (silent)");
    return;
  }
  const m = out.match(/<<<POST>>>([\s\S]*?)<<<END>>>/);
  const slackMsg = (m ? m[1] : "").trim();
  if (!slackMsg) { console.log("[bugsink-poll] empty triage message, skipping"); return; }

  // Post the incident. When DISPATCH_ENABLED, this goes via the Slack API so we
  // capture the thread ts and watch it for a human approval (👍 / keyword) that
  // lets Kent author a Linear issue for Leo. Otherwise it sends as before.
  await postIncidentToSlack(slackMsg, { summary: slackMsg });
}

function startBugsinkPoller() {
  if (!process.env.BUGSINK_URL?.trim() || !process.env.BUGSINK_API_TOKEN?.trim()) return;
  const interval = Number.parseInt(process.env.BUGSINK_POLL_INTERVAL_MS ?? "300000", 10) || 300_000;
  console.log(`[wrapper] BugSink → Kent poller enabled (every ${Math.round(interval / 1000)}s)`);
  setTimeout(() => pollBugsinkOnce().catch((e) => console.warn("[bugsink-poll]", String(e))), 30_000);
  const t = setInterval(() => pollBugsinkOnce().catch((e) => console.warn("[bugsink-poll]", String(e))), interval);
  t.unref?.();
}

// ===========================================================================
// Dispatch flow (AHO): Kent triage → human Slack-approval → Kent authors a
// Linear issue (wrapper writes; Kent stays read-only) → Leo polls Linear →
// Leo sessions_send → EVA (full-tools coder) implements + opens a PR.
// All gated behind DISPATCH_ENABLED=true. Off by default → deploy is inert.
//
// Env:
//   DISPATCH_ENABLED=true            master switch
//   SLACK_BOT_TOKEN                  (else read from channels.slack.botToken)
//   INCIDENT_SLACK_TARGET            channel:C0XXXXXXX  (reused from poller)
//   DISPATCH_APPROVERS               csv Slack user ids allowed to approve (empty = any human)
//   DISPATCH_APPROVE_KEYWORDS        csv reply keywords (default: skapa,go,ja,kör,approve,dispatch)
//   DISPATCH_APPROVE_REACTION        reaction name (default: +1 → 👍)
//   DISPATCH_LABEL                   Linear label for new issues (default: agent-dispatch)
//   LEO_AGENT / WORKER_AGENT         agent ids (default: leo / eva)
//   DISPATCH_SLACK_POLL_MS / DISPATCH_LINEAR_POLL_MS
//   LINEAR_API_KEY / LINEAR_TEAM_ID  (reused from poller)
// ===========================================================================

const dispatchEnabled = () => String(process.env.DISPATCH_ENABLED || "").toLowerCase() === "true";
const dispatchLabel = () => process.env.DISPATCH_LABEL?.trim() || "agent-dispatch";

function dispLoad(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), "utf8")); } catch { return fallback; }
}
function dispSave(file, data) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, file), JSON.stringify(data)); } catch {}
}

// ---- Slack Web API (bot token from env or openclaw config) ----
let _slackToken;
function slackToken() {
  if (_slackToken !== undefined) return _slackToken;
  let t = process.env.SLACK_BOT_TOKEN?.trim();
  if (!t) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      const slack = cfg?.channels?.slack || {};
      const accounts = slack.accounts || {};
      // Tokens live under channels.slack.accounts.<account>.botToken (per-bot:
      // kent/leo). Kent posts + watches the incident thread, so prefer its token.
      const preferred = process.env.DISPATCH_SLACK_ACCOUNT?.trim()
        || process.env.BUGSINK_KENT_AGENT?.trim() || "kent";
      t = slack.botToken || slack.bot_token
        || accounts[preferred]?.botToken || accounts[preferred]?.bot_token
        || Object.values(accounts).map((a) => a?.botToken || a?.bot_token).find(Boolean);
    } catch {}
  }
  _slackToken = t || null;
  return _slackToken;
}
function slackChannelId() {
  const m = (process.env.INCIDENT_SLACK_TARGET || "").trim().match(/(?:channel:)?([A-Z0-9]{8,})/i);
  return m ? m[1] : null;
}
async function slackCall(method, params = {}) {
  const token = slackToken();
  if (!token) return { ok: false, error: "no_slack_token" };
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) body.set(k, String(v));
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return await res.json();
  } catch (err) { return { ok: false, error: String(err) }; }
}
let _botUserId;
async function slackBotUserId() {
  if (_botUserId !== undefined) return _botUserId;
  const r = await slackCall("auth.test");
  _botUserId = r?.ok ? r.user_id : null;
  return _botUserId;
}

// Post an incident. When dispatch is on, go via Slack API so we capture the
// thread ts to watch for approval; otherwise fall back to `openclaw message send`.
async function postIncidentToSlack(text, context) {
  const target = process.env.INCIDENT_SLACK_TARGET?.trim();
  const channel = slackChannelId();
  if (dispatchEnabled() && slackToken() && channel) {
    const kw = (process.env.DISPATCH_APPROVE_KEYWORDS || "skapa,go,ja,kör,approve,dispatch").split(",")[0].trim();
    const hint = `\n\n_👍 eller svara "${kw}" i tråden → Linear-issue skapas i Backlog (flytta till Todo för att låta Leo dispatcha)._`;
    const r = await slackCall("chat.postMessage", { channel, text: text + hint });
    if (r?.ok && r.ts) {
      const threads = dispLoad("dispatch-threads.json", {});
      threads[r.ts] = { channel, ts: r.ts, postedAt: Date.now(), approved: false, context };
      dispSave("dispatch-threads.json", threads);
      console.log(`[dispatch] incident posted (ts=${r.ts}); awaiting Slack approval`);
      return;
    }
    console.warn(`[dispatch] chat.postMessage failed (${JSON.stringify(r).slice(0, 160)}); falling back to openclaw send`);
  }
  try {
    await runCmd(OPENCLAW_NODE, clawArgs(["message", "send", "--channel", "slack", "--target", target, "--message", text]), { timeoutMs: 60_000 });
    console.log("[bugsink-poll] incident posted to Slack");
  } catch (err) { console.warn(`[bugsink-poll] slack send failed: ${String(err)}`); }
}

// ---- Linear GraphQL (read + write) ----
async function linearGql(query, variables) {
  const key = process.env.LINEAR_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) { console.warn(`[dispatch] Linear HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (data?.errors) { console.warn(`[dispatch] Linear errors: ${JSON.stringify(data.errors).slice(0, 300)}`); return null; }
    return data?.data || null;
  } catch (err) { console.warn(`[dispatch] Linear fetch failed: ${String(err)}`); return null; }
}
const _labelIdCache = {};
async function ensureLinearLabel(name) {
  if (_labelIdCache[name]) return _labelIdCache[name];
  const teamId = process.env.LINEAR_TEAM_ID?.trim();
  if (!teamId) return null;
  const found = await linearGql(`query($teamId:String!){ team(id:$teamId){ labels(first:200){ nodes{ id name } } } }`, { teamId });
  const existing = (found?.team?.labels?.nodes || []).find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) return (_labelIdCache[name] = existing.id);
  const created = await linearGql(`mutation($teamId:String!,$name:String!){ issueLabelCreate(input:{teamId:$teamId,name:$name}){ issueLabel{ id } } }`, { teamId, name });
  const id = created?.issueLabelCreate?.issueLabel?.id || null;
  if (id) _labelIdCache[name] = id;
  return id;
}
// Resolve the Linear user the agents act as (issues get assigned to "Leo").
let _leoUserId;
async function linearLeoUserId() {
  if (_leoUserId !== undefined) return _leoUserId;
  const who = process.env.DISPATCH_LEO_LINEAR_USER?.trim() || "leo";
  const data = await linearGql(
    `query($q:String!){ users(filter:{ or:[ { name:{ containsIgnoreCase:$q } }, { displayName:{ containsIgnoreCase:$q } }, { email:{ containsIgnoreCase:$q } } ] }){ nodes{ id name displayName } } }`,
    { q: who },
  );
  const nodes = data?.users?.nodes || [];
  const exact = nodes.find((u) => [u.name, u.displayName].some((n) => String(n || "").toLowerCase() === who.toLowerCase()));
  _leoUserId = (exact || nodes[0])?.id || null;
  if (!_leoUserId) console.warn(`[dispatch] no Linear user matching "${who}" — issues won't be assigned`);
  return _leoUserId;
}

// Team workflow states (id/name/type), cached. Used for In Progress / review moves.
let _teamStates;
async function linearTeamStates() {
  if (_teamStates) return _teamStates;
  const teamId = process.env.LINEAR_TEAM_ID?.trim();
  if (!teamId) return [];
  const data = await linearGql(`query($teamId:String!){ team(id:$teamId){ states{ nodes{ id name type } } } }`, { teamId });
  _teamStates = data?.team?.states?.nodes || [];
  return _teamStates;
}
async function linearStateByName(name, fallbackContains) {
  const states = await linearTeamStates();
  return (
    states.find((s) => s.name.toLowerCase() === String(name).toLowerCase()) ||
    (fallbackContains ? states.find((s) => s.name.toLowerCase().includes(fallbackContains)) : null) ||
    null
  );
}
async function linearSetState(issueId, stateId) {
  await linearGql(`mutation($id:String!,$stateId:String!){ issueUpdate(id:$id, input:{ stateId:$stateId }){ success } }`, { id: issueId, stateId });
}

async function createLinearIssue(title, description) {
  const teamId = process.env.LINEAR_TEAM_ID?.trim();
  if (!process.env.LINEAR_API_KEY?.trim() || !teamId) { console.warn("[dispatch] LINEAR_API_KEY/TEAM_ID missing"); return null; }
  const labelId = await ensureLinearLabel(dispatchLabel());
  const assigneeId = await linearLeoUserId();
  // Create in Backlog: the Slack approval creates the issue, but moving it to
  // Todo is the human's dispatch trigger (Leo only polls Todo onwards).
  const todoState = await linearStateByName(process.env.DISPATCH_CREATE_STATE?.trim() || "Backlog");
  const input = {
    teamId, title, description,
    ...(labelId ? { labelIds: [labelId] } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(todoState ? { stateId: todoState.id } : {}),
  };
  const data = await linearGql(`mutation($input:IssueCreateInput!){ issueCreate(input:$input){ issue{ id identifier url } } }`, { input });
  const issue = data?.issueCreate?.issue;
  return issue ? { id: issue.id, identifier: issue.identifier, url: issue.url } : null;
}
async function linearAddComment(issueId, body) {
  await linearGql(`mutation($id:String!,$body:String!){ commentCreate(input:{issueId:$id, body:$body}){ success } }`, { id: issueId, body });
}
async function relabelDispatched(issueId) {
  try {
    const fromId = await ensureLinearLabel(dispatchLabel());
    const toId = await ensureLinearLabel("agent-dispatched");
    const cur = await linearGql(`query($id:String!){ issue(id:$id){ labels{ nodes{ id } } } }`, { id: issueId });
    const ids = new Set((cur?.issue?.labels?.nodes || []).map((n) => n.id));
    if (fromId) ids.delete(fromId);
    if (toId) ids.add(toId);
    await linearGql(`mutation($id:String!,$ids:[String!]){ issueUpdate(id:$id, input:{labelIds:$ids}){ success } }`, { id: issueId, ids: [...ids] });
  } catch (err) { console.warn(`[dispatch] relabel failed: ${String(err)}`); }
}

// ---- Full BugSink event detail (stacktrace/tags/breadcrumbs), cached per thread ----
// Kent is read-only — the WRAPPER reads BugSink and feeds him the whole picture,
// both when chatting in the thread and when authoring the Linear issue.
async function fetchBugsinkEventDetail(issueId) {
  const url = process.env.BUGSINK_URL?.trim();
  const token = process.env.BUGSINK_API_TOKEN?.trim();
  if (!url || !token || !issueId) return null;
  const base = url.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  try {
    const listRes = await fetch(`${base}/api/canonical/0/events/?issue=${encodeURIComponent(issueId)}`, { headers });
    if (!listRes.ok) return null;
    const results = (await listRes.json())?.results || [];
    const evId = results.length ? results[results.length - 1].id || results[0].id : null;
    if (!evId) return null;
    const evRes = await fetch(`${base}/api/canonical/0/events/${encodeURIComponent(evId)}/`, { headers });
    if (!evRes.ok) return null;
    const data = (await evRes.json())?.data || {};
    const tags = normalizeTags(data.tags);
    const lines = [];
    lines.push(`environment: ${data.environment || tags.environment || "?"}  source: ${tags.source || tags.server_name || data.platform || "?"}`);
    if (data.transaction || tags.function) lines.push(`route/function: ${data.transaction || tags.function}`);
    if (data.request?.url) lines.push(`url: ${String(data.request.url)}`);
    if (data.logentry?.formatted || data.message) lines.push(`message: ${String(data.logentry?.formatted || data.message).slice(0, 400)}`);
    for (const ex of (data.exception?.values || []).slice(-2)) {
      lines.push(`exception: ${ex.type || "?"}: ${String(ex.value || "").slice(0, 300)}`);
      for (const f of (ex.stacktrace?.frames || []).slice(-8)) {
        lines.push(`  at ${f.function || "?"} (${f.filename || f.abs_path || "?"}:${f.lineno ?? "?"})`);
      }
    }
    const bc = data.breadcrumbs?.values || [];
    if (bc.length) {
      lines.push("breadcrumbs (sista 5):");
      for (const b of bc.slice(-5)) lines.push(`  [${b.category || b.type || "-"}] ${String(b.message || JSON.stringify(b.data || {})).slice(0, 140)}`);
    }
    return redactSensitive(lines.join("\n")).slice(0, 3500);
  } catch (err) {
    console.warn(`[dispatch] bugsink detail fetch failed: ${String(err)}`);
    return null;
  }
}
async function ensureBugsinkContext(rec) {
  if (rec.context?.bugsink) return rec.context.bugsink;
  const id = (String(rec.context?.summary || "").match(/issues\/issue\/([0-9a-f-]{36})/i) || [])[1];
  if (!id) return null;
  const detail = await fetchBugsinkEventDetail(id);
  if (detail) { rec.context = rec.context || {}; rec.context.bugsink = detail; }
  return detail;
}

// ---- Kent authors a Linear issue (read-only agent; wrapper does the write) ----
// He gets the FULL BugSink event + the open-issue list, and must answer
// <<<EXISTING>>> if the incident is already covered — no duplicates.
async function kentAuthorIssue(rec) {
  const agent = process.env.BUGSINK_KENT_AGENT?.trim() || "kent";
  const detail = await ensureBugsinkContext(rec);
  const open = await fetchLinearOpenIssues();
  const openList = open.length ? open.map((i) => `- ${i.identifier}: ${i.title}`).join("\n") : "(inga öppna issues hämtade)";
  const prompt = [
    "En människa har godkänt åtgärd för följande BugSink-incident.",
    "",
    "Incident (Slack-meddelandet):",
    String(rec.context?.summary || "(saknas)").slice(0, 2200),
    "",
    detail ? `Fullständig BugSink-detalj (senaste eventet):\n${detail}` : "(ingen BugSink-detalj kunde hämtas)",
    "",
    "Öppna Linear-issues just nu:",
    openList,
    "",
    "Du är Kent. FÖRST: avgör om incidenten redan täcks av en öppen issue ovan.",
    "Om JA — svara EXAKT så här och inget annat:",
    "<<<EXISTING>>>",
    "<identifier, t.ex. AHO-1234>",
    "<<<END>>>",
    "Om NEJ — författa EN ny Linear-issue på svenska för Leo att dispatcha:",
    "vad felet är, var (källa/route), BugSink-länken EXAKT, stacktrace-essensen, och en kort föreslagen åtgärd.",
    "Inkludera ALDRIG PII / e-post / tokens / nycklar / kunddata.",
    "<<<TITLE>>>",
    "<kort titel>",
    "<<<BODY>>>",
    "<beskrivning i markdown>",
    "<<<END>>>",
  ].join("\n");
  let out = "";
  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["agent", "--agent", agent, "--message", prompt]), { timeoutMs: 180_000 });
    out = r.output || "";
  } catch (err) { console.warn(`[dispatch] Kent author failed: ${String(err)}`); return null; }
  const ex = out.match(/<<<EXISTING>>>([\s\S]*?)<<<END>>>/);
  if (ex) {
    const identifier = (ex[1].match(/[A-Z]+-\d+/) || [])[0];
    if (identifier) return { existing: identifier };
  }
  const m = out.match(/<<<TITLE>>>([\s\S]*?)<<<BODY>>>([\s\S]*?)<<<END>>>/);
  if (!m) { console.warn("[dispatch] Kent reply had no TITLE/BODY/EXISTING markers"); return null; }
  const title = redactSensitive(m[1].trim()).slice(0, 250);
  const body = redactSensitive(m[2].trim()).slice(0, 6000);
  return title ? { title, body } : null;
}

// ---- Poll watched Slack threads: human approval (👍/keyword) + thread chat ----
// Non-keyword replies are forwarded to the Kent agent (with the incident context
// and a per-thread session for continuity) and his answer is posted back in the
// thread — so the incident thread is an actual conversation with Kent, with the
// approval signal (👍/keyword) layered on top. Opt out: DISPATCH_THREAD_CHAT=false.
async function fetchThreadState(rec) {
  const rr = await slackCall("reactions.get", { channel: rec.channel, timestamp: rec.ts });
  const cr = await slackCall("conversations.replies", { channel: rec.channel, ts: rec.ts, limit: 100 });
  return {
    reactions: rr?.ok ? rr.message?.reactions || [] : [],
    messages: cr?.ok ? cr.messages || [] : [],
  };
}
// A thumbs-up in ANY form approves: a reaction whose name matches the configured
// list or contains "thumbsup", OR a thread message that is/contains 👍 / :+1: /
// :thumbsup*: — people use custom emoji like :thumbsup_all: as messages too.
const THUMB_MSG_RE = /👍|:\+1:|:thumbsup[a-z_]*:/i;
function findApproval(state, rec, opts) {
  const allowed = (uid) => uid && uid !== opts.botId && (opts.approvers.length === 0 || opts.approvers.includes(uid));
  for (const re of state.reactions) {
    const name = String(re.name || "").toLowerCase();
    if (opts.reactions.includes(name) || name.includes("thumbsup")) {
      const by = (re.users || []).find(allowed);
      if (by) return { by, via: "reaction" };
    }
  }
  for (const msg of state.messages) {
    if (msg.ts === rec.ts || msg.bot_id || !allowed(msg.user)) continue;
    const txt = String(msg.text || "").toLowerCase();
    if (opts.keywords.some((k) => txt.includes(k)) || THUMB_MSG_RE.test(txt)) {
      return { by: msg.user, via: "reply", ts: msg.ts };
    }
  }
  return null;
}

// Forward one human thread-reply to Kent and return his (redacted) answer.
// A stable per-thread session key gives Kent memory across turns in the thread.
async function kentThreadReply(rec, question) {
  const agent = process.env.BUGSINK_KENT_AGENT?.trim() || "kent";
  const sessionKey = `agent:${agent}:incident-${String(rec.ts).replace(/\./g, "-")}`;
  const detail = await ensureBugsinkContext(rec);
  const prompt = [
    "Du är Kent, drift-agent, och svarar i en Slack-incident-tråd. Svara på REN SVENSKA, kort och konkret.",
    "",
    "Incident-kontext:",
    String(rec.context?.summary || "(saknas)").slice(0, 2200),
    "",
    detail ? `Fullständig BugSink-detalj (senaste eventet):\n${detail}` : "(ingen BugSink-detalj kunde hämtas)",
    "",
    `Människans meddelande i tråden: ${String(question || "").slice(0, 1500)}`,
    "",
    "Svara utifrån kontexten ovan — säg ärligt om något inte framgår av den.",
    "Om människan vill gå vidare med en fix: påminn om att 👍:a eller svara 'skapa' — då skapas en Linear-issue i Backlog; flytta den till Todo så dispatchar Leo.",
    "Inkludera ALDRIG PII / e-post / tokens / nycklar / kunddata.",
    "Svara EXAKT i detta format och inget annat:",
    "<<<REPLY>>>",
    "<ditt svar>",
    "<<<END>>>",
  ].join("\n");
  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["agent", "--agent", agent, "--session-key", sessionKey, "--message", prompt]), { timeoutMs: 120_000 });
    const m = (r.output || "").match(/<<<REPLY>>>([\s\S]*?)<<<END>>>/);
    const text = m ? redactSensitive(m[1].trim()).slice(0, 2900) : "";
    return text || null;
  } catch (err) {
    console.warn(`[dispatch] kent thread reply failed: ${String(err)}`);
    return null;
  }
}

// Adopt incident posts the wrapper didn't track itself (e.g. posted via the
// legacy `openclaw message send` path before dispatch went live, or during a
// fallback). Scans recent channel history for Kent-bot messages that look like
// incidents and aren't in the threads file — so 👍/keyword/chat works in EVERY
// incident thread (≤48h), not only ones posted by the new code path.
async function adoptUntrackedIncidents(threads) {
  const channel = slackChannelId();
  if (!channel) return false;
  const botId = await slackBotUserId();
  const hist = await slackCall("conversations.history", { channel, limit: 100 });
  if (!hist?.ok) return false;
  const cutoff = Date.now() - 48 * 3600 * 1000;
  let changed = false;
  for (const msg of hist.messages || []) {
    const ts = msg.ts;
    if (!ts || threads[ts]) continue;
    const postedAt = Math.floor(Number(ts) * 1000);
    if (!Number.isFinite(postedAt) || postedAt < cutoff) continue;
    if (!(msg.bot_id || msg.user === botId)) continue; // only Kent-bot posts
    const text = String(msg.text || "");
    if (!/incident/i.test(text)) continue;
    threads[ts] = { channel, ts, postedAt, approved: false, adopted: true, context: { summary: text.slice(0, 3000) } };
    changed = true;
    console.log(`[dispatch] adopted untracked incident thread ts=${ts}`);
  }
  return changed;
}

async function pollSlackApprovals() {
  if (!dispatchEnabled() || !slackToken()) return;
  const threads = dispLoad("dispatch-threads.json", {});
  const opts = {
    keywords: (process.env.DISPATCH_APPROVE_KEYWORDS || "skapa,go,ja,kör,approve,dispatch").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    reactions: (process.env.DISPATCH_APPROVE_REACTION || "+1,thumbsup,thumbsup_all").split(",").map((s) => s.replace(/:/g, "").trim().toLowerCase()).filter(Boolean),
    approvers: (process.env.DISPATCH_APPROVERS || "").split(",").map((s) => s.trim()).filter(Boolean),
    botId: await slackBotUserId(),
  };
  const chatEnabled = String(process.env.DISPATCH_THREAD_CHAT ?? "true").toLowerCase() !== "false";
  const TTL = 48 * 3600 * 1000;
  let changed = await adoptUntrackedIncidents(threads);
  for (const [ts, rec] of Object.entries(threads)) {
    if (Date.now() - (rec.postedAt || 0) > TTL) { delete threads[ts]; changed = true; continue; }
    const state = await fetchThreadState(rec);
    rec.answered = rec.answered || [];

    // 1) Approval → Kent authors → wrapper creates the Linear issue.
    if (!rec.approved) {
      const approval = findApproval(state, rec, opts);
      if (approval) {
        console.log(`[dispatch] approval on ts=${ts} via ${approval.via} by ${approval.by}`);
        // Mark every keyword-bearing reply as handled — repeated "skapa issue"
        // messages are all part of the same approval, not chat to answer.
        for (const msg of state.messages) {
          if (msg.ts !== rec.ts && !msg.bot_id && opts.keywords.some((k) => String(msg.text || "").toLowerCase().includes(k)) && !rec.answered.includes(msg.ts)) {
            rec.answered.push(msg.ts);
          }
        }
        const authored = await kentAuthorIssue(rec);
        if (!authored) {
          await slackCall("chat.postMessage", { channel: rec.channel, thread_ts: ts, text: "⚠️ Kunde inte författa Linear-issue (Kent gav inget svar)." });
        } else if (authored.existing) {
          // Incident already covered by an open issue — link it, never duplicate.
          const match = (await fetchLinearOpenIssues()).find((i) => i.identifier === authored.existing);
          if (match?.id) {
            await linearAddComment(match.id, `🤖 Ny BugSink-förekomst kopplad till denna issue (från incident-tråd i Slack):\n\n${String(rec.context?.summary || "").slice(0, 1500)}`);
          }
          rec.approved = true; rec.issue = authored.existing;
          await slackCall("chat.postMessage", {
            channel: rec.channel, thread_ts: ts,
            text: `↪️ Matchar befintlig ${authored.existing}${match?.url ? ` (${match.url})` : ""} — ingen ny issue skapades. Flytta den till **Todo** om Leo ska dispatcha den.`,
          });
        } else {
          const created = await createLinearIssue(authored.title, authored.body);
          rec.approved = true; rec.issue = created?.identifier || null;
          await slackCall("chat.postMessage", {
            channel: rec.channel, thread_ts: ts,
            text: created?.identifier
              ? `✅ Skapade ${created.identifier} i **Backlog** (label \`${dispatchLabel()}\`, assignad Leo): ${created.url}\nFlytta den till **Todo** så dispatchar Leo.`
              : "⚠️ Kunde inte skapa Linear-issue (se loggar).",
          });
        }
        changed = true;
      }
    }

    // 2) Thread chat: forward unanswered human replies to Kent (skip approval
    //    keywords while approval is still pending — those are the signal).
    if (chatEnabled) {
      const pending = state.messages.filter((m) => {
        if (m.ts === rec.ts || m.bot_id || !m.user || m.user === opts.botId) return false;
        if (rec.answered.includes(m.ts)) return false;
        if (!rec.approved && opts.keywords.some((k) => String(m.text || "").toLowerCase().includes(k))) return false;
        return true;
      }).slice(0, 3); // cap per cycle to keep turns cheap
      for (const msg of pending) {
        rec.answered.push(msg.ts); changed = true;
        const reply = await kentThreadReply(rec, msg.text);
        if (reply) await slackCall("chat.postMessage", { channel: rec.channel, thread_ts: ts, text: reply });
      }
    }
  }
  if (changed) dispSave("dispatch-threads.json", threads);
}

// ---- Poll Linear: (1) Backlog/Todo → Leo dispatches EVA + issue → In Progress;
// ---- (2) In Progress issues where EVA's PR exists (GitHub attachment) → In PR review.
// EVA never merges — humans are the merge gate; Leo owns the status moves.
let _dispatchInFlight = false;
async function pollLinearForDispatch() {
  // EVA runs are long (up to WORKER_TIMEOUT_MS); never let poll ticks overlap.
  if (_dispatchInFlight) return;
  _dispatchInFlight = true;
  try { await _pollLinearForDispatchInner(); } finally { _dispatchInFlight = false; }
}
async function _pollLinearForDispatchInner() {
  if (!dispatchEnabled()) return;
  const teamId = process.env.LINEAR_TEAM_ID?.trim();
  if (!teamId || !process.env.LINEAR_API_KEY?.trim()) return;
  const label = dispatchLabel();
  const leoId = await linearLeoUserId();
  const leo = process.env.LEO_AGENT?.trim() || "leo";
  const worker = process.env.WORKER_AGENT?.trim() || "eva";

  // Issues are "Leo's" if they carry the dispatch label OR are assigned to him.
  const orFilter = leoId
    ? `{ or: [ { labels:{ some:{ name:{ eq:$label } } } }, { assignee:{ id:{ eq:"${leoId}" } } } ] }`
    : `{ labels:{ some:{ name:{ eq:$label } } } }`;

  // ── Phase 1: dispatch from Todo onwards — NOT Backlog (parked/no-touch zone;
  // move an issue to Todo to greenlight it for Leo) ──────────────────────────
  const d1 = await linearGql(
    `query($teamId:String!,$label:String!){ team(id:$teamId){ issues(first:25, filter:{ and:[ ${orFilter}, { state:{ type:{ in:["unstarted"] } } } ] }){ nodes{ id identifier title description url } } } }`,
    { teamId, label },
  );
  const todo = d1?.team?.issues?.nodes || [];
  const seen = new Set(dispLoad("dispatch-seen-issues.json", []));
  // Heartbeat: always prove the poll ran and what it saw (silence was unreadable).
  console.log(
    `[dispatch] linear poll: ${todo.length} Todo-match (label="${label}" or assignee leo=${leoId ? "ok" : "UNRESOLVED"}), ` +
    `${todo.filter((i) => seen.has(i.id)).length} blocked by seen-file`,
  );
  for (const iss of todo) {
    if (seen.has(iss.id)) continue;
    // Mark seen up front so an overlapping poll can never double-dispatch.
    seen.add(iss.id);
    dispSave("dispatch-seen-issues.json", [...seen]);

    // 1) Leo (orchestrator) authors the worker brief. Agent→agent sends are
    //    blocked by the runtime allowlist, so the WRAPPER runs EVA — Leo only
    //    writes the order. Falls back to the raw issue if Leo gives nothing.
    let brief = "";
    try {
      const lp = [
        `Dispatch-issue: ${iss.identifier} — ${iss.title}`,
        iss.url,
        "",
        String(iss.description || "").slice(0, 3000),
        "",
        "Du är Leo (orchestrator). Författa en kort, konkret ARBETSORDER till EVA (kod-agenten):",
        "mål, var i koden (om det framgår), acceptanskriterier, och eventuella fällor.",
        "Svara EXAKT i detta format och inget annat:",
        "<<<BRIEF>>>",
        "<arbetsordern>",
        "<<<END>>>",
      ].join("\n");
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["agent", "--agent", leo, "--message", lp]), { timeoutMs: 120_000 });
      brief = ((r.output || "").match(/<<<BRIEF>>>([\s\S]*?)<<<END>>>/) || [])[1]?.trim() || "";
    } catch (err) { console.warn(`[dispatch] Leo brief failed for ${iss.identifier}: ${String(err)}`); }

    // Status moves first, so Linear reflects reality while EVA works.
    await relabelDispatched(iss.id);
    if (leoId) await linearGql(`mutation($id:String!,$a:String!){ issueUpdate(id:$id, input:{ assigneeId:$a }){ success } }`, { id: iss.id, a: leoId });
    const progress = await linearStateByName(process.env.DISPATCH_PROGRESS_STATE?.trim() || "In Progress");
    if (progress) await linearSetState(iss.id, progress.id);
    await linearAddComment(iss.id, `🤖 Leo dispatchade \`${worker}\`: implementera på \`agent/${iss.identifier}-<slug>\`, PR mot \`staging\`. EVA mergar aldrig.`);

    // 2) Wrapper runs EVA directly with the brief (long turn — she implements + opens the PR).
    const task = [
      `Implementera Linear-issue ${iss.identifier}: ${iss.title}`,
      iss.url,
      "",
      "Arbetsorder från Leo:",
      brief || String(iss.description || "").slice(0, 3000),
      "",
      `Arbeta i Ahody/ahody-repot. Skapa branch \`agent/${iss.identifier}-<kort-slug>\`, implementera fixen, öppna en PR mot \`staging\` med titel som börjar "${iss.identifier}: ".`,
      "Du får ALDRIG merga och ALDRIG pusha direkt till staging/main/dev — människor är merge-grinden.",
      "Avsluta med en kort sammanfattning + PR-länken.",
    ].join("\n");
    const evaTimeoutMs = Number.parseInt(process.env.WORKER_TIMEOUT_MS ?? "1800000", 10) || 1_800_000;
    console.log(`[dispatch] ${iss.identifier}: running ${worker} (timeout ${Math.round(evaTimeoutMs / 60000)} min)`);
    try {
      const r = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["agent", "--agent", worker, "--timeout", String(Math.round(evaTimeoutMs / 1000)), "--message", task]),
        { timeoutMs: evaTimeoutMs + 60_000 },
      );
      if (r.code !== 0) {
        console.warn(`[dispatch] ${worker} run for ${iss.identifier} exited ${r.code}`);
        await linearAddComment(iss.id, `⚠️ ${worker}-körningen avslutades med fel (exit ${r.code}) — ingen PR garanterad. Se wrapper-loggarna.`);
      }
    } catch (err) {
      console.warn(`[dispatch] ${worker} run failed for ${iss.identifier}: ${String(err)}`);
      await linearAddComment(iss.id, `⚠️ ${worker}-körningen kraschade — ingen PR. Se wrapper-loggarna.`);
    }
  }

  // ── Phase 2: In Progress + EVA's PR linked → move to "In PR review" ──────
  const reviewName = process.env.DISPATCH_REVIEW_STATE?.trim() || "In PR review";
  const review = await linearStateByName(reviewName, "review");
  if (!review) { console.warn(`[dispatch] no team state matching "${reviewName}" (or containing "review") — skipping review moves`); return; }
  const d2 = await linearGql(
    `query($teamId:String!,$label:String!){ team(id:$teamId){ issues(first:50, filter:{ and:[ ${orFilter}, { state:{ type:{ in:["started"] } } } ] }){ nodes{ id identifier state{ id name } attachments{ nodes{ url } } } } } }`,
    { teamId, label },
  );
  const started = d2?.team?.issues?.nodes || [];
  const reviewed = new Set(dispLoad("dispatch-reviewed.json", []));
  let rchanged = false;
  for (const iss of started) {
    if (reviewed.has(iss.id) || iss.state?.id === review.id) continue;
    const pr = (iss.attachments?.nodes || []).find((a) => /github\.com\/.+\/pull\/\d+/.test(String(a.url || "")));
    if (!pr) continue; // EVA not done yet — no PR linked
    console.log(`[dispatch] ${iss.identifier}: PR linked (${pr.url}) → "${review.name}"`);
    await linearSetState(iss.id, review.id);
    await linearAddComment(iss.id, `🤖 EVA:s PR är öppnad: ${pr.url} — Leo flyttar till **${review.name}**. Människa reviewar + mergar.`);
    reviewed.add(iss.id); rchanged = true;
  }
  if (rchanged) dispSave("dispatch-reviewed.json", [...reviewed]);
}

function startDispatchPollers() {
  if (!dispatchEnabled()) { console.log("[wrapper] dispatch flow disabled (set DISPATCH_ENABLED=true to enable)"); return; }
  const slackMs = Number.parseInt(process.env.DISPATCH_SLACK_POLL_MS ?? "60000", 10) || 60_000;
  const linMs = Number.parseInt(process.env.DISPATCH_LINEAR_POLL_MS ?? "120000", 10) || 120_000;
  console.log(`[wrapper] dispatch flow ENABLED (approvals every ${Math.round(slackMs / 1000)}s, dispatch every ${Math.round(linMs / 1000)}s)`);
  setTimeout(() => pollSlackApprovals().catch((e) => console.warn("[dispatch-slack]", String(e))), 45_000);
  const t1 = setInterval(() => pollSlackApprovals().catch((e) => console.warn("[dispatch-slack]", String(e))), slackMs);
  const t2 = setInterval(() => pollLinearForDispatch().catch((e) => console.warn("[dispatch-linear]", String(e))), linMs);
  t1.unref?.(); t2.unref?.();
}

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

  // Harden state dir for OpenClaw and avoid missing credentials dir on fresh volumes.
  try {
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  } catch {}
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Optional operator hook to install/persist extra tools under /data.
  // This is intentionally best-effort and should be used to set up persistent
  // prefixes (npm/pnpm/python venv), not to mutate the base image.
  const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
  if (fs.existsSync(bootstrapPath)) {
    console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
    try {
      await runCmd("bash", [bootstrapPath], {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        },
        timeoutMs: 10 * 60 * 1000,
      });
      console.log("[wrapper] bootstrap complete");
    } catch (err) {
      console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
    }
  }

  // Sync gateway tokens in config with the current env var on every startup.
  // This prevents "gateway token mismatch" when OPENCLAW_GATEWAY_TOKEN changes
  // (e.g. Railway variable update) but the config file still has the old value.
  if (isConfigured() && OPENCLAW_GATEWAY_TOKEN) {
    console.log("[wrapper] syncing gateway tokens in config...");
    try {
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      console.log("[wrapper] gateway tokens synced");
    } catch (err) {
      console.warn(`[wrapper] failed to sync gateway tokens: ${String(err)}`);
    }
  }

  // Apply Azure OpenAI provider config from env vars (if set) before the gateway starts,
  // so the gateway picks it up immediately. Idempotent and merge-safe.
  if (isConfigured()) {
    try {
      await ensureAzureProvider();
    } catch (err) {
      console.warn(`[wrapper] Azure provider setup failed (continuing): ${String(err)}`);
    }
  }

  // Configure git → GitHub App auth (if env vars are set) so EVA can clone/push/open PRs.
  try {
    await ensureGitHubAppAuth();
  } catch (err) {
    console.warn(`[wrapper] GitHub App auth setup failed (continuing): ${String(err)}`);
  }

  // Start the BugSink → Kent incident poller (no-op unless BUGSINK_* env vars are set).
  try {
    startBugsinkPoller();
  } catch (err) {
    console.warn(`[wrapper] BugSink poller failed to start (continuing): ${String(err)}`);
  }

  // Start the dispatch pollers (Slack-approval → Kent authors issue; Leo → worker).
  // No-op unless DISPATCH_ENABLED=true.
  try {
    startDispatchPollers();
  } catch (err) {
    console.warn(`[wrapper] dispatch pollers failed to start (continuing): ${String(err)}`);
  }

  // Ensure the logs-ingest table exists (no-op unless LOGS_DB_WRITE_URL is set).
  try {
    await ensureLogsTable();
  } catch (err) {
    console.warn(`[wrapper] logs table init failed (continuing): ${String(err)}`);
  }

  // Auto-start the gateway if already configured so polling channels (Telegram/Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured()) {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  // Note: browsers cannot attach arbitrary HTTP headers (including Authorization: Basic)
  // in WebSocket handshakes. Do not enforce dashboard Basic auth at the upgrade layer.
  // The gateway authenticates at the protocol layer and we inject the gateway token below.

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  attachGatewayAuthHeader(req);
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }

  // Stop accepting new connections; allow in-flight requests to complete briefly.
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }

  setTimeout(() => process.exit(0), 5_000).unref?.();
});
