const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ---------------------------------------------------------------------------
// Config

const ORI_API_BASE = process.env.ORI_API_BASE ?? "https://glm.thynaptic.com/v1";
const ORI_API_KEY  = process.env.ORI_API_KEY  ?? "";

// Hearthstone Power.log path per platform
function getLogPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Preferences/Blizzard/Hearthstone/Logs/Power.log");
  }
  // Windows
  return path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"),
    "Blizzard/Hearthstone/Logs/Power.log"
  );
}

// ---------------------------------------------------------------------------
// Incremental log parser — keeps rolling game state without re-parsing full file

const gameState = {
  turn: 0,
  player: "FRIENDLY",
  friendlyHP: 30,
  opposingHP: 30,
  friendlyMinions: [],
  opposingMinions: [],
  recentActions: [],   // last 20 actions across all turns
  turnActions: [],     // actions in current turn
  result: null,
  active: false,
};

function parseLine(line) {
  // New game
  if (line.includes("CREATE_GAME")) {
    Object.assign(gameState, {
      turn: 0, friendlyHP: 30, opposingHP: 30,
      friendlyMinions: [], opposingMinions: [],
      recentActions: [], turnActions: [], result: null, active: true,
    });
    return;
  }

  // Turn change
  const turnMatch = line.match(/tag=TURN value=(\d+)/) || line.match(/TurnNumber=(\d+)/);
  if (turnMatch && line.includes("TAG_CHANGE")) {
    const n = parseInt(turnMatch[1]);
    if (n !== gameState.turn) {
      gameState.turn = n;
      gameState.player = n % 2 === 1 ? "FRIENDLY" : "OPPOSING";
      gameState.turnActions = [];
    }
    return;
  }

  // Actions
  if (line.includes("BLOCK_START")) {
    const btMatch = line.match(/BLOCK_START BlockType=(\w+)/);
    const nameMatch = line.match(/Entity=\[name=([^\]]+)/);
    const targetMatch = line.match(/Target=\[name=([^\]]+)/);
    if (btMatch && nameMatch) {
      const type = btMatch[1];
      const card = nameMatch[1].trim();
      const target = targetMatch ? targetMatch[1].trim() : null;
      if (["PLAY","ATTACK","POWER"].includes(type) && card !== "GameEntity") {
        const action = { type, card, target };
        gameState.turnActions.push(action);
        gameState.recentActions.push(action);
        if (gameState.recentActions.length > 20) gameState.recentActions.shift();
      }
    }
    return;
  }

  // Zone → board tracking
  const zoneMatch = line.match(/TAG_CHANGE.*tag=ZONE value=(\w+).*Entity=\[name=([^\]]+)/);
  if (zoneMatch) {
    const [, zone, name] = zoneMatch;
    if (zone === "PLAY") {
      if (!gameState.friendlyMinions.includes(name)) gameState.friendlyMinions.push(name);
    }
    if (zone === "GRAVEYARD") {
      gameState.friendlyMinions = gameState.friendlyMinions.filter(m => m !== name);
      gameState.opposingMinions = gameState.opposingMinions.filter(m => m !== name);
    }
    return;
  }

  // HP
  const hpMatch = line.match(/TAG_CHANGE.*tag=HEALTH value=(\d+)/);
  if (hpMatch) {
    const hp = parseInt(hpMatch[1]);
    if (!line.includes("OPPOSING")) gameState.friendlyHP = hp;
    else gameState.opposingHP = hp;
    return;
  }

  // Game over
  const goMatch = line.match(/TAG_CHANGE.*PLAYSTATE=(WON|LOST|CONCEDED|TIED)/);
  if (goMatch) {
    gameState.result = goMatch[1];
    gameState.active = false;
  }
}

function buildGameContext() {
  if (!gameState.active && !gameState.result) {
    return "No active Hearthstone game detected.";
  }
  const lines = [
    `Turn ${gameState.turn} (${gameState.player}'s turn)`,
    `Friendly: ${gameState.friendlyHP} HP | Board: ${gameState.friendlyMinions.join(", ") || "empty"}`,
    `Opposing: ${gameState.opposingHP} HP | Board: ${gameState.opposingMinions.join(", ") || "empty"}`,
  ];
  if (gameState.turnActions.length > 0) {
    lines.push(`This turn: ${gameState.turnActions.map(a => `[${a.type}] ${a.card}${a.target ? " → " + a.target : ""}`).join(", ")}`);
  }
  if (gameState.result) {
    lines.push(`Game over: ${gameState.result}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Log tailer

let logWatcher = null;
let logFd      = null;
let logPos     = 0;
let win        = null;

function startLogTailer() {
  const logPath = getLogPath();

  function readNew() {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size <= logPos) return;
    const buf  = Buffer.alloc(stat.size - logPos);
    const fd   = fs.openSync(logPath, "r");
    fs.readSync(fd, buf, 0, buf.length, logPos);
    fs.closeSync(fd);
    logPos = stat.size;
    const lines = buf.toString("utf-8").split(/\r?\n/);
    for (const line of lines) parseLine(line);
    if (win && !win.isDestroyed()) {
      win.webContents.send("game-state", buildGameContext());
    }
  }

  // Reset position on new game (file truncated/replaced)
  function checkReset() {
    if (!fs.existsSync(logPath)) { logPos = 0; return; }
    const stat = fs.statSync(logPath);
    if (stat.size < logPos) logPos = 0; // file was reset
  }

  // Initial read
  if (fs.existsSync(logPath)) {
    logPos = fs.statSync(logPath).size; // start from current end, don't replay history
  }

  logWatcher = fs.watch(path.dirname(logPath), { persistent: false }, (event, filename) => {
    if (filename === "Power.log") {
      checkReset();
      readNew();
    }
  });

  // Poll fallback every 2s in case fs.watch misses events (Windows quirk)
  setInterval(() => { checkReset(); readNew(); }, 2000);
}

// ---------------------------------------------------------------------------
// ORI streaming fetch

async function askORI(userMessage, win) {
  const context = buildGameContext();
  const messages = [
    {
      role: "user",
      content: `Current Hearthstone game state:\n${context}\n\n---\n\n${userMessage}`,
    },
  ];

  const response = await fetch(`${ORI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ORI_API_KEY}`,
    },
    body: JSON.stringify({ model: "", stream: true, messages }),
  });

  if (!response.ok) {
    const err = await response.text();
    win.webContents.send("ori-error", `ORI error ${response.status}: ${err}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") { win.webContents.send("ori-done"); return; }
      try {
        const chunk = JSON.parse(data);
        const token = chunk?.choices?.[0]?.delta?.content;
        if (token) win.webContents.send("ori-token", token);
      } catch { /* skip malformed */ }
    }
  }
  win.webContents.send("ori-done");
}

// ---------------------------------------------------------------------------
// Window

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 340,
    height: 520,
    x: width  - 360,
    y: height - 540,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  win.loadFile("bubble.html");
  win.setAlwaysOnTop(true, "screen-saver"); // highest level — above fullscreen apps

  if (process.argv.includes("--dev")) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  // Click-through — only the bubble itself is interactive (handled via IPC)
  win.setIgnoreMouseEvents(true, { forward: true });

  ipcMain.on("set-interactive", (_, interactive) => {
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.on("ask-ori", async (_, message) => {
    try {
      await askORI(message, win);
    } catch (e) {
      win.webContents.send("ori-error", e.message);
    }
  });

  ipcMain.on("get-game-state", () => {
    win.webContents.send("game-state", buildGameContext());
  });

  ipcMain.on("quit", () => app.quit());

  startLogTailer();
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
