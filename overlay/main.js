const { app, BrowserWindow, ipcMain, screen, shell } = require("electron");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { startOAuthFlow, getValidToken, loadToken }                       = require("./auth");
const { loadCards, fetchCollection, saveCollection, loadCollection,
        decodeDeckCode, encodeDeckCode,
        loadLearnedCollection, mergeGameDeck }                            = require("./collection");
const { META_URLS, processMeta, saveMeta, loadMeta, loadMetaStale, isStale,
        classifyDeck, buildMetaSummary, buildMatchupNote }               = require("./meta");

// ---------------------------------------------------------------------------
// Load .env before anything reads process.env

const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Config

const ORI_API_BASE        = process.env.ORI_API_BASE        ?? "https://glm.thynaptic.com/v1";
const ORI_API_KEY         = process.env.ORI_API_KEY         ?? "";
const BLIZZ_CLIENT_ID     = process.env.BLIZZ_CLIENT_ID     ?? "";
const BLIZZ_CLIENT_SECRET = process.env.BLIZZ_CLIENT_SECRET ?? "";
const BLIZZ_REGION        = process.env.BLIZZ_REGION        ?? "us";

// Hearthstone log directory per platform.
function getLogDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/Logs/Blizzard Entertainment/Hearthstone");
  }
  return path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"),
    "Blizzard/Hearthstone/Logs"
  );
}

// Known log filenames in priority order. If none match, fall back to the
// most recently modified .log file in the directory — handles Blizzard renames.
const KNOWN_LOG_NAMES = ["Player.log", "Power.log", "player.log", "power.log"];

function findLogFile(logDir) {
  if (!fs.existsSync(logDir)) return null;

  for (const name of KNOWN_LOG_NAMES) {
    const p = path.join(logDir, name);
    if (fs.existsSync(p)) return p;
  }

  // Fallback — most recently modified .log in the directory
  try {
    const entries = fs.readdirSync(logDir)
      .filter(f => f.toLowerCase().endsWith(".log"))
      .map(f => { const p = path.join(logDir, f); return { p, mtime: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length) {
      console.log(`[ORIStone] Log auto-detected: ${path.basename(entries[0].p)}`);
      return entries[0].p;
    }
  } catch { /* ignore */ }

  return null;
}

// ---------------------------------------------------------------------------
// Incremental log parser — keeps rolling game state without re-parsing full file

// Cards seen in the current game's deck reveal (cardId → { name, count })
// Merged into the learned collection when the game ends.
let gameDeck = {};

// Per-player state: index 1 and 2 map to PlayerID 1 and 2.
// localPlayerNum is determined at runtime from SHOW_ENTITY plain reveals + CONTROLLER tags.
const gameState = {
  turn: 0,
  displayTurn: 0,        // actual in-game turn number from per-player TURN tag
  activePlayerNum: 0,   // 1 or 2 — who has CURRENT_PLAYER
  localPlayerNum: 0,    // 1 or 2 — detected from SHOW_ENTITY + CONTROLLER mapping
  heroEntityIds: new Set(), // entity IDs that are heroes — excluded from board/hand
  entityCardTypes: new Map(), // id -> CARDTYPE
  entityController: new Map(), // id -> playerNum — populated from CONTROLLER tags
  entityToPlayerNum: new Map(), // Player EntityID -> PlayerID (from CREATE_GAME Player blocks)
  entityZone: new Map(),        // id -> current zone string (HAND/PLAY/DECK/etc.)
  entityName: new Map(),        // id -> display name (set when SHOW_ENTITY reveals card)
  lastEntityId: null,
  p: {
    1: { hp: 30, hero: "", board: [], hand: [] },
    2: { hp: 30, hero: "", board: [], hand: [] },
  },
  mulligan: { fired: false },
  recentActions: [],
  turnActions: [],
  result: null,
  active: false,
  oppRevealedCardIds: new Set(), // cardIds seen from opponent's SHOW_ENTITY
  oppArchetype: null,            // last classifyDeck result for opponent
};

// Extract name, player number, and entity id from a bracket.
// macOS format: [entityName=Foo id=N zone=Z ... player=N]
// Old format:   [id=N name=Foo player=N]
function parseEntity(entityStr) {
  // entityName= takes priority; fall back to name=
  const nameMatch = entityStr.match(/entityName=([^\] ]+(?:\s+[^\]=][^\] ]*)*)/)
                 ?? entityStr.match(/(?<![a-z])name=([^\] ]+(?:\s+[^\]=][^\] ]*)*)/);
  // Strip any trailing key=value noise — take only the first word(s) before a bare `key=`
  let name = (nameMatch?.[1] ?? "").trim();
  // Trim off anything from the first `key=` pattern (e.g. " id=68 zone=...")
  name = name.replace(/\s+\w+=.*$/, "").trim();
  const player = parseInt((entityStr.match(/\bplayer=(\d+)/) || [])[1] || "0");
  const id     = parseInt((entityStr.match(/\bid=(\d+)/) || [])[1] || "0");
  return { name, player, id };
}

function parseLine(raw) {
  // On macOS, power data lives in Player.log with a [Power] prefix.
  let line = raw;
  const powerIdx = raw.indexOf("[Power]");
  if (powerIdx !== -1) {
    line = raw.slice(powerIdx + 7).trim();
  } else if (process.platform === "darwin") {
    return;
  }

  // ── 1. Track Entity IDs and CardTypes ─────────────────────────────────────
  // macOS Player.log uses "Creating ID=N" for initial setup; bracket [id=N] for mid-game
  const bracketIdMatch  = line.match(/(?:FULL_ENTITY|SHOW_ENTITY).*\[id=(\d+)/);
  const creatingIdMatch = line.match(/FULL_ENTITY - Creating\s+ID=(\d+)\s+CardID=(\S*)/);
  if (bracketIdMatch) {
    gameState.lastEntityId = parseInt(bracketIdMatch[1]);
  } else if (creatingIdMatch) {
    gameState.lastEntityId = parseInt(creatingIdMatch[1]);
    const cid = creatingIdMatch[2];
    if (cid && cid.startsWith("HERO_")) gameState.heroEntityIds.add(gameState.lastEntityId);
    if (cid) {
      const n = cardIdToName.get(cid);
      if (n) gameState.entityName.set(gameState.lastEntityId, n);
    }
  }

  // HERO_ENTITY tag in the Player block during CREATE_GAME names the hero entity
  const heroEntityMatch = line.match(/\btag=HERO_ENTITY value=(\d+)/);
  if (heroEntityMatch) gameState.heroEntityIds.add(parseInt(heroEntityMatch[1]));

  // CARDTYPE tag — macOS logs use string values (MINION/SPELL/HERO…), not just numbers
  const ctMatch = line.match(/\btag=CARDTYPE value=(\w+)/);
  if (ctMatch && gameState.lastEntityId !== null) {
    const v  = ctMatch[1];
    const CT = { HERO: 3, MINION: 4, SPELL: 5, ENCHANTMENT: 6, WEAPON: 7, HERO_POWER: 10 };
    const type = isNaN(v) ? (CT[v] ?? 0) : parseInt(v);
    if (type) gameState.entityCardTypes.set(gameState.lastEntityId, type);
  }

  // CONTROLLER tag — maps entity IDs to player numbers during CREATE_GAME setup
  const controllerMatch = line.match(/\btag=CONTROLLER value=(\d+)/);
  if (controllerMatch && gameState.lastEntityId !== null) {
    gameState.entityController.set(gameState.lastEntityId, parseInt(controllerMatch[1]));
  }

  // ZONE tag (inline in FULL_ENTITY blocks) — needed to track opening hand entities
  const zoneTagMatch = line.match(/\btag=ZONE value=(\w+)/);
  if (zoneTagMatch && gameState.lastEntityId !== null) {
    gameState.entityZone.set(gameState.lastEntityId, zoneTagMatch[1]);
  }

  // ── New game ──────────────────────────────────────────────────────────────
  if (line.includes("CREATE_GAME")) {
    gameDeck                = {};
    gameState.turn          = 0;
    gameState.displayTurn   = 0;
    gameState.activePlayerNum = 0;
    gameState.localPlayerNum  = 0;
    gameState.heroEntityIds   = new Set();
    gameState.entityCardTypes = new Map();
    gameState.entityController  = new Map();
    gameState.entityToPlayerNum = new Map();
    gameState.entityZone        = new Map();
    gameState.entityName        = new Map();
    gameState.lastEntityId      = null;
    gameState.p[1] = { hp: 30, hero: "", board: [], hand: [] };
    gameState.p[2] = { hp: 30, hero: "", board: [], hand: [] };
    gameState.recentActions     = [];
    gameState.turnActions       = [];
    gameState.result            = null;
    gameState.mulligan          = { fired: false };
    gameState.active            = true;
    gameState.oppRevealedCardIds = new Set();
    gameState.oppArchetype       = null;
    if (win && !win.isDestroyed()) win.webContents.send("opp-archetype", null);
    return;
  }

  // ── Turn number ───────────────────────────────────────────────────────────
  // ── Mulligan detection ────────────────────────────────────────────────────
  if (!gameState.mulligan.fired && line.includes("TAG_CHANGE") && line.includes("tag=STEP") && line.includes("BEGIN_MULLIGAN")) {
    gameState.mulligan.fired = true;

    // Derive localPlayerNum if not yet known: your opening hand cards have known names, opp's don't
    if (!gameState.localPlayerNum) {
      for (const [id, zone] of gameState.entityZone) {
        if (zone !== "HAND") continue;
        if (!gameState.entityName.has(id)) continue;
        const ctrl = gameState.entityController.get(id);
        if (ctrl) { gameState.localPlayerNum = ctrl; break; }
      }
    }

    const lp = gameState.localPlayerNum;
    const hand = [];
    if (lp) {
      for (const [id, zone] of gameState.entityZone) {
        if (zone !== "HAND") continue;
        if (gameState.entityController.get(id) !== lp) continue;
        const name = gameState.entityName.get(id);
        if (name && !name.startsWith("UNKNOWN")) hand.push(name);
      }
    }

    if (hand.length && win && !win.isDestroyed()) {
      const oppNum  = lp === 1 ? 2 : 1;
      const oppHero = gameState.p[oppNum]?.hero || "unknown";
      const prompt  = `Mulligan — I was dealt: ${hand.join(", ")}. Opponent is ${oppHero}. What should I keep and why?`;
      win.webContents.send("mulligan-start", { hand, prompt });
      askORI(prompt, win, []);
    }
    return;
  }

  const turnMatch = line.match(/TAG_CHANGE Entity=GameEntity tag=TURN value=(\d+)/);
  if (turnMatch) {
    const n = parseInt(turnMatch[1]);
    if (n !== gameState.turn) {
      gameState.turn = n;
      gameState.turnActions = [];
      // Odd global turn = P1 active, even = P2 active
      gameState.activePlayerNum = n % 2 === 1 ? 1 : 2;
    }
    return;
  }

  // Per-player TURN tag fires alongside GameEntity TURN — gives actual in-game turn number
  const playerTurnMatch = line.match(/TAG_CHANGE Entity=(?!GameEntity)\S+ tag=TURN value=(\d+)/);
  if (playerTurnMatch) {
    gameState.displayTurn = parseInt(playerTurnMatch[1]);
    return;
  }

  // ── Player EntityID → PlayerID mapping (from CREATE_GAME Player blocks) ──────
  const playerBlockMatch = line.match(/Player EntityID=(\d+) PlayerID=(\d+)/);
  if (playerBlockMatch) {
    gameState.entityToPlayerNum.set(parseInt(playerBlockMatch[1]), parseInt(playerBlockMatch[2]));
    return;
  }

  // ── Whose turn it is — Entity=N (plain ID) format on macOS ───────────────
  const curMatch = line.match(/TAG_CHANGE Entity=(\d+) tag=CURRENT_PLAYER value=1/);
  if (curMatch) {
    const playerNum = gameState.entityToPlayerNum.get(parseInt(curMatch[1]));
    if (playerNum) gameState.activePlayerNum = playerNum;
    return;
  }

  // ── Zone changes: board + hand tracking ──────────────────────────────────
  const zoneMatch = line.match(/TAG_CHANGE Entity=\[([^\]]+)\] tag=ZONE value=(\w+)/);
  if (zoneMatch) {
    const { name, player, id } = parseEntity(zoneMatch[1]);
    const zone = zoneMatch[2];
    // Always track zone by entity ID — needed for opening hand reveals via SHOW_ENTITY
    if (id) gameState.entityZone.set(id, zone);
    if (!name || !player || name.startsWith("UNKNOWN ENTITY")) return;
    if (gameState.heroEntityIds.has(id)) {
      // Capture hero name from HERO-type entities entering PLAY at game start
      if (name && player && gameState.p[player] && !name.startsWith("UNKNOWN") &&
          gameState.entityCardTypes.get(id) === 3) {
        gameState.p[player].hero = name;
      }
      return;
    }

    const cardType = gameState.entityCardTypes.get(id);
    // Unknown type (generated token, discovered card) → allow on board; known non-minion/weapon → skip
    const isMinionOrWeapon = cardType === undefined || cardType === 4 || cardType === 7;

    const p = gameState.p[player];
    if (!p) return;

    // Remove from board and hand first, then re-add if needed
    p.board = p.board.filter(m => m !== name);
    p.hand  = p.hand.filter(m => m !== name);

    if (zone === "PLAY") {
      // Only add to board if it's a minion (4) or weapon (7)
      if (isMinionOrWeapon) p.board.push(name);
    }
    if (zone === "HAND") {
      if (!p.hand.includes(name)) p.hand.push(name);
      // Any player whose hand we can name-resolve is the local player
      if (!gameState.localPlayerNum) gameState.localPlayerNum = player;
    }
    return;
  }

  // ── HP changes — heroes only (DAMAGE tag = damage taken; currentHP = 30 - damage) ──
  const hpMatch = line.match(/TAG_CHANGE Entity=\[([^\]]+)\] tag=DAMAGE value=(\d+)/);
  if (hpMatch) {
    const { name, player, id } = parseEntity(hpMatch[1]);
    const damage = parseInt(hpMatch[2]);
    if (player && gameState.p[player] && gameState.heroEntityIds.has(id)) {
      gameState.p[player].hp = Math.max(0, 30 - damage);
      if (name && !gameState.p[player].hero) gameState.p[player].hero = name;
    }
    return;
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  if (line.includes("BLOCK_START")) {
    const btMatch     = line.match(/BLOCK_START BlockType=(\w+)/);
    const entityMatch = line.match(/Entity=\[([^\]]+)\]/);
    const targetMatch = line.match(/Target=\[([^\]]+)\]/);
    if (btMatch && entityMatch) {
      const type   = btMatch[1];
      const { name: card, player } = parseEntity(entityMatch[1]);
      const target = targetMatch ? parseEntity(targetMatch[1]).name : null;
      if (["PLAY", "ATTACK", "POWER"].includes(type) && card && card !== "GameEntity") {
        const action = { type, card, target, player };
        gameState.turnActions.push(action);
        gameState.recentActions.push(action);
        if (gameState.recentActions.length > 20) gameState.recentActions.shift();
      }
    }
    return;
  }

  // ── FULL_ENTITY — register heroes and learn cards from deck reveal ────────
  const feMatch = line.match(/FULL_ENTITY.*Updating \[([^\]]+)\] CardID=(\S+)/);
  if (feMatch) {
    const { name, player, id } = parseEntity(feMatch[1]);
    const cardId = feMatch[2];
    if (!cardId || cardId === "0") return;

    // Track hero entity IDs so they're excluded from board/hand tracking
    if (cardId.startsWith("HERO_")) {
      if (id) gameState.heroEntityIds.add(id);
      if (name && player && gameState.p[player] && !gameState.p[player].hero) {
        gameState.p[player].hero = name;
      }
      return;
    }

    // Only real deck cards (FULL_ENTITY in zone=DECK at game start) identify local player
    if (name && !name.startsWith("UNKNOWN") && player) {
      if (!gameState.localPlayerNum) gameState.localPlayerNum = player;
      if (player === gameState.localPlayerNum) {
        const existing = gameDeck[cardId];
        gameDeck[cardId] = { name, count: existing ? Math.min(existing.count + 1, 2) : 1 };
      }
    }
    return;
  }

  // ── Plain SHOW_ENTITY — card revealed (GameState format, Entity=N plain number) ──
  const sePlainMatch = line.match(/SHOW_ENTITY - Updating Entity=(\d+)\s+CardID=(\S+)/);
  if (sePlainMatch) {
    const entityId = parseInt(sePlainMatch[1]);
    const cardId   = sePlainMatch[2];
    const player   = gameState.entityController.get(entityId);
    if (player && !gameState.localPlayerNum) {
      gameState.localPlayerNum = player;
      console.log(`[ORIStone] Local player detected: P${player}`);
    }
    // Store name by entity ID so hand can be computed on demand
    const cardName = cardIdToName.get(cardId);
    if (cardName) gameState.entityName.set(entityId, cardName);
    return;
  }

  // ── Bracket SHOW_ENTITY — card revealed (PowerTaskList format, Entity=[...]) ──
  const seMatch = line.match(/SHOW_ENTITY - Updating Entity=\[([^\]]+)\] CardID=(\S+)/);
  if (seMatch) {
    const { name, player, id } = parseEntity(seMatch[1]);
    const cardId = seMatch[2];
    // Store resolved name for on-demand hand computation
    if (id && name && !name.startsWith("UNKNOWN")) gameState.entityName.set(id, name);
    if (!cardId || cardId === "0" || cardId.startsWith("HERO_")) return;
    const lp = gameState.localPlayerNum;
    if (lp && player && player !== lp && !gameState.oppRevealedCardIds.has(cardId)) {
      gameState.oppRevealedCardIds.add(cardId);
      tryClassifyOpponent();
    }
    return;
  }

  // ── Game over ─────────────────────────────────────────────────────────────
  const goMatch = line.match(/TAG_CHANGE.*PLAYSTATE=(WON|LOST|CONCEDED|TIED)/);
  if (goMatch) {
    gameState.result = goMatch[1];
    gameState.active = false;
    // Flush this game's deck into the learned collection
    if (Object.keys(gameDeck).length > 0) {
      const stats = mergeGameDeck(gameDeck);
      console.log(`[ORIStone] Collection learned: +${stats.added} new, ${stats.updated} updated → ${stats.total} cards across ${stats.games} games`);
      if (workshopWin && !workshopWin.isDestroyed())
        workshopWin.webContents.send("ws:collection-loaded", loadLearnedCollection().cards);
    }
    // Fire recap after a short delay so all log lines settle
    setTimeout(() => generateRecap(), 1500);
  }
}

function buildGameContext() {
  if (!gameState.active && !gameState.result) {
    return "No active Hearthstone game detected.";
  }

  const lp = gameState.localPlayerNum || 1; // default to P1 if not yet resolved
  const op = lp === 1 ? 2 : 1;
  const local = gameState.p[lp];
  const opp   = gameState.p[op];

  const isMyTurn    = gameState.activePlayerNum === lp;
  const displayTurn = gameState.displayTurn || Math.ceil(gameState.turn / 2);
  const turnStr = gameState.turn > 0
    ? `Turn ${displayTurn} — ${isMyTurn ? "Your turn" : "Opponent's turn"}`
    : "Game starting…";

  // Compute hand on demand — zone and name are tracked separately and may update at different times
  const myHand = [];
  for (const [id, zone] of gameState.entityZone) {
    if (zone !== "HAND") continue;
    if (gameState.entityController.get(id) !== lp) continue;
    const name = gameState.entityName.get(id);
    if (name && !name.startsWith("UNKNOWN")) myHand.push(name);
  }

  const lines = [
    turnStr,
    `You (${local.hero || "?"}): ${local.hp} HP | Board: ${local.board.join(", ") || "empty"}`,
    `Hand: ${myHand.join(", ") || "unknown"}`,
    `Opponent (${opp.hero || "?"}): ${opp.hp} HP | Board: ${opp.board.join(", ") || "empty"}`,
  ];

  if (gameState.oppArchetype) {
    const a    = gameState.oppArchetype;
    const conf = a.confidence >= 50 ? "" : " (uncertain)";
    const tier = a.tier     ? ` · Tier ${a.tier}`      : "";
    const wr   = a.winRate != null ? ` · ${a.winRate}% WR` : "";
    lines.push(`Opponent archetype: ${a.name} (${a.playerClass})${tier}${wr}${conf}`);
  }
  if (gameState.turnActions.length > 0) {
    lines.push(`This turn: ${gameState.turnActions.map(a => `[${a.type}] ${a.card}${a.target ? " → " + a.target : ""}`).join(", ")}`);
  }
  if (gameState.result) {
    lines.push(`Result: ${gameState.result}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Game recap

const RECAPS_PATH  = path.join(os.homedir(), ".config", "oristone", "recaps.json");
const MAX_RECAPS   = 50;

function saveRecap(recap) {
  let recaps = [];
  try { if (fs.existsSync(RECAPS_PATH)) recaps = JSON.parse(fs.readFileSync(RECAPS_PATH, "utf-8")); }
  catch { recaps = []; }
  recaps.push(recap);
  if (recaps.length > MAX_RECAPS) recaps = recaps.slice(-MAX_RECAPS);
  try {
    const d = path.dirname(RECAPS_PATH);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(RECAPS_PATH, JSON.stringify(recaps, null, 2));
  } catch (e) {
    console.warn("[recap] save failed:", e.message);
  }
}

async function generateRecap() {
  if (!gameState.result || !win || win.isDestroyed()) return;

  const lp    = gameState.localPlayerNum || 1;
  const op    = lp === 1 ? 2 : 1;
  const local = gameState.p[lp];
  const opp   = gameState.p[op];

  const deckList = Object.values(gameDeck).map(c => `${c.count}x ${c.name}`).join(", ") || "unknown";

  const recentStr = gameState.recentActions.length
    ? gameState.recentActions.slice(-12).map(a => `[${a.type}] ${a.card}${a.target ? " → " + a.target : ""}`).join(", ")
    : "none recorded";

  const oppStr = gameState.oppArchetype
    ? `${gameState.oppArchetype.name} (${gameState.oppArchetype.playerClass}, Tier ${gameState.oppArchetype.tier ?? "?"}, ${gameState.oppArchetype.winRate ?? "?"}% WR)`
    : opp.hero || "unknown";

  const context = [
    `Result: ${gameState.result}`,
    `Game length: turn ${gameState.displayTurn || Math.ceil(gameState.turn / 2)}`,
    `You (${local.hero || "?"}): final board — ${local.board.join(", ") || "empty"}`,
    `Opponent (${oppStr}): final board — ${opp.board.join(", ") || "empty"}`,
    `Your deck: ${deckList}`,
    `Recent plays: ${recentStr}`,
  ].join("\n");

  const meta        = loadMeta();
  const metaSection = meta ? `\n\n${buildMetaSummary(meta)}` : "";

  const messages = [
    {
      role: "system",
      content: `You are ORI, a Hearthstone coach. Write a concise 3-sentence game recap: what happened overall, what the key turning point was (name specific cards if possible), and one concrete thing to do differently. Be direct. No labels, no bullet points.${metaSection}`,
    },
    { role: "user", content: context },
  ];

  const resultEmoji = gameState.result === "WON" ? "🏆" : gameState.result === "TIED" ? "🤝" : "💀";
  win.webContents.send("recap-start", { result: gameState.result, turn: gameState.displayTurn || Math.ceil(gameState.turn / 2), oppStr });

  try {
    const response = await fetch(`${ORI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ORI_API_KEY}` },
      body: JSON.stringify({ model: "", stream: true, messages }),
    });

    if (!response.ok) {
      win.webContents.send("recap-error", `ORI error ${response.status}`);
      return;
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

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
        if (data === "[DONE]") break;
        try {
          const token = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (token) { fullText += token; win.webContents.send("recap-token", token); }
        } catch { /* skip */ }
      }
    }

    win.webContents.send("recap-done");
    saveRecap({
      id:           Date.now().toString(),
      result:       gameState.result,
      turn:         gameState.turn,
      myHero:       local.hero || "",
      oppHero:      opp.hero || "",
      oppArchetype: gameState.oppArchetype ?? null,
      text:         fullText,
      timestamp:    Date.now(),
    });
    console.log("[recap] saved");
  } catch (e) {
    console.warn("[recap] failed:", e.message);
    win.webContents.send("recap-error", e.message);
  }
}

// ---------------------------------------------------------------------------
// Opponent archetype classifier

function tryClassifyOpponent() {
  const meta   = loadMeta() ?? loadMetaStale();
  if (!meta) return;
  const cardIds = [...gameState.oppRevealedCardIds];
  if (cardIds.length < 3) return;

  const result = classifyDeck(cardIds, null, meta);
  if (!result || result.confidence < 20) return;

  const prev = gameState.oppArchetype;
  if (prev?.id === result.id && prev?.confidence === result.confidence) return;

  gameState.oppArchetype = result;
  if (win && !win.isDestroyed()) win.webContents.send("opp-archetype", result);
}

// ---------------------------------------------------------------------------
// Log tailer

let logWatcher = null;
let logFd      = null;
let logPos     = 0;
let win        = null;

function startLogTailer() {
  const logDir = getLogDir();
  let activePath = findLogFile(logDir);

  if (activePath) {
    console.log(`[ORIStone] Watching: ${path.basename(activePath)}`);
  } else {
    console.log(`[ORIStone] No log file found in ${logDir} — will keep checking`);
  }

  function readNew() {
    // Re-discover each tick in case Blizzard swapped the filename
    const current = findLogFile(logDir);
    if (!current) return;
    if (current !== activePath) {
      console.log(`[ORIStone] Log file changed: ${path.basename(current)}`);
      activePath = current;
      logPos = 0;
    }
    const stat = fs.statSync(current);
    if (stat.size <= logPos) return;
    const buf = Buffer.alloc(stat.size - logPos);
    const fd  = fs.openSync(current, "r");
    fs.readSync(fd, buf, 0, buf.length, logPos);
    fs.closeSync(fd);
    logPos = stat.size;
    const lines = buf.toString("utf-8").split(/\r?\n/);
    for (const line of lines) parseLine(line);
    if (win && !win.isDestroyed()) {
      win.webContents.send("game-state", buildGameContext());
    }
  }

  function checkReset() {
    if (!activePath || !fs.existsSync(activePath)) { logPos = 0; return; }
    const stat = fs.statSync(activePath);
    if (stat.size < logPos) logPos = 0;
  }

  // Initial read — parse existing content so in-progress games are detected on launch
  if (activePath) {
    const content = fs.readFileSync(activePath, "utf-8");
    for (const line of content.split(/\r?\n/)) parseLine(line);
    logPos = fs.statSync(activePath).size;
  }

  if (fs.existsSync(logDir)) {
    logWatcher = fs.watch(logDir, { persistent: false }, (event, filename) => {
      if (filename && filename.toLowerCase().endsWith(".log")) {
        checkReset();
        readNew();
      }
    });
  }

  // Poll fallback every 2s in case fs.watch misses events (Windows quirk)
  setInterval(() => { checkReset(); readNew(); }, 2000);
}

// ---------------------------------------------------------------------------
// Debug log

const DEBUG_LOG_PATH = path.join(os.homedir(), ".config", "oristone", "debug.log");

function debugLog(label, content) {
  const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `\n[${ts}] ${label}\n${content}\n${"─".repeat(60)}`;
  try {
    const dir = path.dirname(DEBUG_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(DEBUG_LOG_PATH, line, "utf-8");
  } catch { /* never crash on debug */ }
}

// ---------------------------------------------------------------------------
// ORI streaming fetch

async function askORI(userMessage, win, history = []) {
  const context = buildGameContext();
  const meta        = loadMeta();
  const metaSection = meta ? `\n\n${buildMetaSummary(meta)}` : "";

  debugLog("USER →", userMessage);
  debugLog("GAME CONTEXT →", context);
  debugLog("RAW STATE →", `active=${gameState.active} localP=${gameState.localPlayerNum} heroIds=[${[...gameState.heroEntityIds].join(",")}] p1={hero:"${gameState.p[1].hero}" hp:${gameState.p[1].hp}} p2={hero:"${gameState.p[2].hero}" hp:${gameState.p[2].hp}}`);

  const messages = [
    {
      role: "system",
      content: `You are ORI, a live Hearthstone coach embedded in an overlay. Be brief and direct — 1 to 3 sentences max. Give the play or the call, not an essay. Use plain language. No bullet lists, no headers, no labels or prefixes. Speak naturally — never start with a classification tag or "Analysis:". If you need to ask a clarifying question, ask just one. Think like a good player whispering advice mid-game.${metaSection}`,
    },
    ...history.map(h => ({ role: h.role, content: h.content })),
    {
      role: "user",
      content: `Game state:\n${context}\n\n${userMessage}`,
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
  let fullResponse = "";

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
      if (data === "[DONE]") {
        debugLog("ORI ←", fullResponse);
        win.webContents.send("ori-done");
        return;
      }
      try {
        const chunk = JSON.parse(data);
        const token = chunk?.choices?.[0]?.delta?.content;
        if (token) { fullResponse += token; win.webContents.send("ori-token", token); }
      } catch { /* skip malformed */ }
    }
  }
  debugLog("ORI ←", fullResponse);
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

  ipcMain.on("ask-ori", async (_, { message, history }) => {
    try {
      await askORI(message, win, history ?? []);
    } catch (e) {
      win.webContents.send("ori-error", e.message);
    }
  });

  ipcMain.on("get-game-state", () => {
    win.webContents.send("game-state", buildGameContext());
  });

  ipcMain.on("quit", () => app.quit());

  ipcMain.on("open-workshop", () => createWorkshopWindow());

  startLogTailer();
}

// ---------------------------------------------------------------------------
// Workshop window

let workshopWin  = null;
let cardData     = null;
let cardIdToName = new Map(); // HS card ID string → display name

async function initCardData() {
  try {
    cardData = await loadCards();
    for (const c of cardData) {
      if (c.id && c.name) cardIdToName.set(c.id, c.name);
    }
    console.log(`[ORIStone] Card DB: ${cardData.length} cards`);
    if (workshopWin && !workshopWin.isDestroyed()) {
      workshopWin.webContents.send("ws:cards-ready", cardData);
    }
  } catch (e) {
    console.warn("[ORIStone] Card DB load failed:", e.message);
  }
}

function createWorkshopWindow() {
  if (workshopWin && !workshopWin.isDestroyed()) {
    workshopWin.show(); workshopWin.focus(); return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const W = 980;

  workshopWin = new BrowserWindow({
    width: W, height,
    x: width - W, y: 0,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "workshop-preload.js"),
      contextIsolation: true,
    },
  });

  workshopWin.loadFile("workshop.html");
  workshopWin.on("closed", () => { workshopWin = null; });

  // Send card data once ready
  workshopWin.webContents.on("did-finish-load", () => {
    if (cardData) workshopWin.webContents.send("ws:cards-ready", cardData);
  });
}

// ---------------------------------------------------------------------------
// Workshop IPC

ipcMain.handle("ws:get-cards", () => cardData ?? []);

ipcMain.handle("ws:status", () => {
  const cached  = loadCollection();
  const token   = loadToken();
  const learned = loadLearnedCollection();
  return {
    hasToken:       !!token,
    hasCollection:  !!cached,
    fetchedAt:      cached?.fetched_at ?? null,
    learnedCards:   Object.keys(learned.cards).length,
    learnedGames:   learned.games,
    learnedData:    learned.cards,
  };
});

ipcMain.handle("ws:authenticate", async () => {
  if (!BLIZZ_CLIENT_ID || !BLIZZ_CLIENT_SECRET)
    throw new Error("BLIZZ_CLIENT_ID / BLIZZ_CLIENT_SECRET not set in .env");
  const token = await startOAuthFlow(BLIZZ_CLIENT_ID, BLIZZ_CLIENT_SECRET, BLIZZ_REGION);
  try {
    const col = await fetchCollection(token.access_token, BLIZZ_REGION);
    saveCollection(col);
    if (workshopWin && !workshopWin.isDestroyed())
      workshopWin.webContents.send("ws:collection-loaded", col);
  } catch (e) { console.warn("[ORIStone] Collection fetch after auth failed:", e.message); }
  return { success: true };
});

ipcMain.handle("ws:sync-collection", async () => {
  const token = await getValidToken(BLIZZ_CLIENT_ID, BLIZZ_CLIENT_SECRET, BLIZZ_REGION);
  if (!token) throw new Error("Not authenticated — connect Blizzard first");
  try {
    const col = await fetchCollection(token.access_token, BLIZZ_REGION);
    saveCollection(col);
    if (workshopWin && !workshopWin.isDestroyed())
      workshopWin.webContents.send("ws:collection-loaded", col);
    return { success: true };
  } catch (e) {
    console.warn("[ORIStone] Collection sync failed:", e.message);
    throw new Error("Collection API unavailable — Blizzard doesn't expose this publicly yet.");
  }
});

ipcMain.handle("ws:import-deck", (_, code)  => decodeDeckCode(code));
ipcMain.handle("ws:export-deck", (_, { heroDbfId, cards, format }) =>
  encodeDeckCode(heroDbfId, cards, format));

// ---------------------------------------------------------------------------
// Saved decks

const SAVED_DECKS_PATH = path.join(os.homedir(), ".config", "oristone", "saved-decks.json");

function loadSavedDecks() {
  if (!fs.existsSync(SAVED_DECKS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(SAVED_DECKS_PATH, "utf-8")); }
  catch { return []; }
}

ipcMain.handle("ws:load-decks", () => loadSavedDecks());
ipcMain.handle("ws:save-decks", (_, decks) => {
  const dir = path.dirname(SAVED_DECKS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SAVED_DECKS_PATH, JSON.stringify(decks, null, 2));
  return true;
});

ipcMain.handle("ws:meta-urls",      () => META_URLS);
ipcMain.handle("ws:meta-status",    () => ({ stale: isStale(), hasData: !!loadMeta() }));
ipcMain.handle("ws:get-meta",       () => loadMeta());
ipcMain.handle("ws:classify-deck",  (_, { ids, cls }) => classifyDeck(ids, cls, loadMeta()));

ipcMain.on("ws:meta-data", (_, raw) => {
  try {
    const cardDbfMap = {};
    if (cardData) for (const c of cardData) cardDbfMap[c.dbfId] = c.name;
    const processed = processMeta(raw, cardDbfMap);
    saveMeta(processed);
    console.log(`[ORIStone] Meta updated — ${processed.topDecks.length} archetypes`);
    if (workshopWin && !workshopWin.isDestroyed())
      workshopWin.webContents.send("ws:meta-ready", processed);
  } catch (e) {
    console.warn("[ORIStone] Meta processing failed:", e.message);
  }
});

ipcMain.on("ws:ask-ori", async (_, { message, deck, history }) => {
  if (!workshopWin || workshopWin.isDestroyed()) return;
  try { await askORIWorkshop(message, deck, history ?? [], workshopWin); }
  catch (e) { workshopWin.webContents.send("ws:ori-error", e.message); }
});

ipcMain.on("ws:close", () => {
  if (workshopWin && !workshopWin.isDestroyed()) workshopWin.close();
});

// ---------------------------------------------------------------------------
// ORI — workshop (deck context)

async function askORIWorkshop(userMessage, deck, history = [], targetWin) {
  const format    = deck?.format ?? "Standard";
  const deckClass = deck?.class || "";
  const deckStr   = deck?.cards?.length
    ? `Current deck — ${deckClass || "unknown"} class, ${format}, ${deck.cards.length}/30 cards. IMPORTANT: this is confirmed as a ${deckClass || "the selected"} class deck — do not reclassify it based on card names or themes. Cards: ${deck.cards.map(c => `${c.count}x ${c.name}`).join(", ")}`
    : `No deck built yet. Format: ${format}.`;

  const meta        = loadMeta();
  const metaSection = meta ? `\n\n${buildMetaSummary(meta)}` : "";

  const messages = [
    {
      role: "system",
      content: `You are ORI, a Hearthstone deck building coach. Speak naturally and directly — 2-4 sentences max. Give specific card recommendations with brief reasoning. No bullet lists, no headers, no labels, no prefixes like "Analysis:". Never start with a classification tag. Use exact archetype names — never combine two with a slash.

DECK ACTIONS — you must include a code block every time you make a change. Without the block, nothing is applied to the builder. Never describe a change without including it.

If the user asks you to BUILD, CREATE, SUGGEST, or RECOMMEND a deck (even if cards are already in the builder), output a deck block with EXACTLY 30 cards. This replaces the current deck entirely:
\`\`\`deck
[{"name":"Card Name","count":2},{"name":"Legendary Card","count":1}]
\`\`\`
Max 2 copies per card. Max 1 copy for Legendaries. Must total exactly 30 cards. Only use cards legal in ${format} format.

If the user asks you to ADD, REMOVE, SWAP, TWEAK, OPTIMIZE, or IMPROVE cards in the current deck, output an edit block with only the cards that change:
\`\`\`edit
[{"op":"add","name":"Card Name","count":2},{"op":"remove","name":"Other Card","count":1}]
\`\`\`
"count" defaults to 1 if omitted. Use exact Hearthstone card names. No other text inside either block.${metaSection}`,
    },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: `${deckStr}\n\n${userMessage}` },
  ];

  const response = await fetch(`${ORI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ORI_API_KEY}` },
    body: JSON.stringify({ model: "", stream: true, messages }),
  });

  if (!response.ok) {
    targetWin.webContents.send("ws:ori-error", `ORI error ${response.status}`);
    return;
  }

  const reader  = response.body.getReader();
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
      if (data === "[DONE]") { targetWin.webContents.send("ws:ori-done"); return; }
      try {
        const chunk = JSON.parse(data);
        const token = chunk?.choices?.[0]?.delta?.content;
        if (token) targetWin.webContents.send("ws:ori-token", token);
      } catch { /* skip */ }
    }
  }
  targetWin.webContents.send("ws:ori-done");
}

// ---------------------------------------------------------------------------
// Boot

app.whenReady().then(async () => {
  createWindow();
  await initCardData();
});
app.on("window-all-closed", () => app.quit());
