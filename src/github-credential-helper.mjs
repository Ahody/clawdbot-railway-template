#!/usr/bin/env node
// Git credential helper that mints short-lived GitHub App installation tokens on demand.
//
// Configured at boot by ensureGitHubAppAuth() in server.js when these env vars are present:
//   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY (PEM)
//
// git invokes this for github.com. For the "get" operation we build an App JWT, exchange it
// for a 1h installation access token, and print it as the password (username x-access-token).
// No token is ever persisted: each git operation mints a fresh one.
import crypto from "node:crypto";

const op = process.argv[2];
// Modes: git credential protocol ("get"), or "--token" to print a raw
// installation token (used as GH_TOKEN for `gh pr create` by the code agent).
const tokenMode = op === "--token";
// We only handle "get"/"--token". For "store"/"erase" there is nothing to persist/clear.
if (op !== "get" && !tokenMode) process.exit(0);

const appId = process.env.GITHUB_APP_ID?.trim();
const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
let privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

// Not configured -> emit nothing so git falls through (and fails with a clear auth error).
if (!appId || !installationId || !privateKey) process.exit(0);

// Some secret stores keep PEM newlines as literal "\n"; normalize to real newlines.
if (privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  // GitHub App JWT: iss=appId, max 10 min lifetime; backdate iat for clock skew.
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ahody-agent-credential-helper",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    process.stderr.write(`[gh-cred] installation token request failed: ${res.status} ${res.statusText} ${body}\n`);
    process.exit(1);
  }

  const data = await res.json();
  if (!data?.token) {
    process.stderr.write("[gh-cred] no token in GitHub response\n");
    process.exit(1);
  }

  if (tokenMode) {
    // Raw token for GH_TOKEN consumers (gh CLI / REST calls).
    process.stdout.write(`${data.token}\n`);
    return;
  }
  // git credential protocol: key=value lines on stdout.
  process.stdout.write(`username=x-access-token\npassword=${data.token}\n`);
}

main().catch((err) => {
  process.stderr.write(`[gh-cred] error: ${String(err)}\n`);
  process.exit(1);
});
