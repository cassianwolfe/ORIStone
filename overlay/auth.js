const http    = require("http");
const { shell } = require("electron");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const crypto  = require("crypto");

const TOKEN_PATH    = path.join(os.homedir(), ".config", "oristone", "blizz-token.json");
const REDIRECT_PORT = 9898;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}/oauth/callback`;

const REGION_HOSTS = {
  us: "https://us.battle.net",
  eu: "https://eu.battle.net",
  kr: "https://kr.battle.net",
};

function getAuthURL(clientId, region, state) {
  const base = REGION_HOSTS[region] ?? REGION_HOSTS.us;
  const params = new URLSearchParams({
    client_id:     clientId,
    scope:         "openid",
    state,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
  });
  return `${base}/oauth/authorize?${params}`;
}

async function exchangeCode(code, clientId, clientSecret, region) {
  const base  = REGION_HOSTS[region] ?? REGION_HOSTS.us;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res   = await fetch(`${base}/oauth/token`, {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveToken(token) {
  ensureDir(TOKEN_PATH);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...token, saved_at: Date.now() }, null, 2));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8")); }
  catch { return null; }
}

function isExpired(token) {
  if (!token?.saved_at || !token?.expires_in) return true;
  return Date.now() > token.saved_at + (token.expires_in - 300) * 1000;
}

async function refreshToken(token, clientId, clientSecret, region) {
  if (!token?.refresh_token) return null;
  const base  = REGION_HOSTS[region] ?? REGION_HOSTS.us;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  try {
    const res = await fetch(`${base}/oauth/token`, {
      method:  "POST",
      headers: {
        Authorization:  `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: token.refresh_token,
      }).toString(),
    });
    if (!res.ok) return null;
    const refreshed = await res.json();
    saveToken(refreshed);
    return refreshed;
  } catch { return null; }
}

async function getValidToken(clientId, clientSecret, region) {
  let token = loadToken();
  if (!token) return null;
  if (isExpired(token)) token = await refreshToken(token, clientId, clientSecret, region);
  return token;
}

function startOAuthFlow(clientId, clientSecret, region) {
  return new Promise((resolve, reject) => {
    const state   = crypto.randomBytes(16).toString("hex");
    let settled   = false;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/oauth/callback") { res.writeHead(404); res.end(); return; }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;
        padding:60px;background:#0d101a;color:#90cdf4">
        <h2>ORIStone connected!</h2><p>You can close this tab.</p></body></html>`);
      server.close();

      if (settled) return;
      settled = true;

      const code          = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      if (returnedState !== state) { reject(new Error("OAuth state mismatch")); return; }
      if (!code)                   { reject(new Error("No code in callback"));  return; }

      try {
        const token = await exchangeCode(code, clientId, clientSecret, region);
        saveToken(token);
        resolve(token);
      } catch (e) { reject(e); }
    });

    server.listen(REDIRECT_PORT, () => {
      shell.openExternal(getAuthURL(clientId, region, state));
    });

    server.on("error", reject);

    // 5-minute timeout
    setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error("OAuth timeout — no response within 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

module.exports = { startOAuthFlow, getValidToken, loadToken, saveToken, isExpired };
