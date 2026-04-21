const fs   = require("fs");
const path = require("path");
const os   = require("os");

const CARDS_PATH      = path.join(os.homedir(), ".config", "oristone", "cards.json");
const COLLECTION_PATH = path.join(os.homedir(), ".config", "oristone", "collection.json");
const LEARNED_PATH    = path.join(os.homedir(), ".config", "oristone", "learned-collection.json");
const CARDS_URL       = "https://api.hearthstonejson.com/v1/latest/enUS/cards.collectible.json";
const CARDS_TTL       = 24 * 60 * 60 * 1000; // 24 hours

const BLIZZ_API = {
  us: "https://us.api.blizzard.com",
  eu: "https://eu.api.blizzard.com",
  kr: "https://kr.api.blizzard.com",
};

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Card DB (HearthstoneJSON — public, no auth)

async function loadCards() {
  if (fs.existsSync(CARDS_PATH)) {
    const cached = JSON.parse(fs.readFileSync(CARDS_PATH, "utf-8"));
    if (Date.now() - cached.fetched_at < CARDS_TTL) return cached.data;
  }
  const res = await fetch(CARDS_URL);
  if (!res.ok) throw new Error(`Card DB fetch failed: ${res.status}`);
  const data = await res.json();
  ensureDir(CARDS_PATH);
  fs.writeFileSync(CARDS_PATH, JSON.stringify({ data, fetched_at: Date.now() }));
  return data;
}

// ---------------------------------------------------------------------------
// Blizzard collection (authenticated)

async function fetchCollection(accessToken, region = "us") {
  const host = BLIZZ_API[region] ?? BLIZZ_API.us;
  const res  = await fetch(
    `${host}/hearthstone/cards/collection?locale=en_US`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Collection fetch failed: ${res.status} — ${await res.text()}`);
  return res.json();
}

function saveCollection(data) {
  ensureDir(COLLECTION_PATH);
  fs.writeFileSync(COLLECTION_PATH, JSON.stringify({ data, fetched_at: Date.now() }, null, 2));
}

function loadCollection() {
  if (!fs.existsSync(COLLECTION_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(COLLECTION_PATH, "utf-8")); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Deck code — varint encode/decode (standard HS format)

function readVarint(buf, offset) {
  let val = 0, shift = 0;
  while (true) {
    const byte = buf[offset++];
    val |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { val, offset };
    shift += 7;
  }
}

function writeVarint(val, out) {
  while (true) {
    const byte = val & 0x7f;
    val >>>= 7;
    if (val === 0) { out.push(byte); return; }
    out.push(byte | 0x80);
  }
}

const FORMAT_NAMES = { 1: "Wild", 2: "Standard", 3: "Classic", 4: "Twist" };
const FORMAT_IDS   = { Wild: 1, Standard: 2, Classic: 3, Twist: 4 };

function decodeDeckCode(deckCode) {
  // New HS copy format embeds the base64 code among human-readable lines.
  // Extract the raw base64 line (doesn't start with # and isn't blank).
  const raw = deckCode.trim();
  let base64 = raw;
  if (raw.includes("\n")) {
    const b64Line = raw.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#"));
    if (b64Line) base64 = b64Line;
  }
  const buf = Buffer.from(base64, "base64");
  let off = 0;

  function next() { const r = readVarint(buf, off); off = r.offset; return r.val; }

  next(); // reserved 0
  next(); // version 1
  const format   = next();
  const heroCount = next();
  const heroes   = Array.from({ length: heroCount }, next);
  const singles  = Array.from({ length: next() }, next);
  const doubles  = Array.from({ length: next() }, next);

  return {
    format: FORMAT_NAMES[format] ?? "Unknown",
    formatId: format,
    heroes,
    cards: [
      ...singles.map(dbfId => ({ dbfId, count: 1 })),
      ...doubles.map(dbfId => ({ dbfId, count: 2 })),
    ],
  };
}

function encodeDeckCode(heroDbfId, cards, format = 2) {
  const singles = cards.filter(c => c.count === 1).map(c => c.dbfId).sort((a, b) => a - b);
  const doubles = cards.filter(c => c.count === 2).map(c => c.dbfId).sort((a, b) => a - b);
  const out = [];

  writeVarint(0, out); // reserved
  writeVarint(1, out); // version
  writeVarint(typeof format === "string" ? (FORMAT_IDS[format] ?? 2) : format, out);
  writeVarint(1, out); // one hero
  writeVarint(heroDbfId, out);
  writeVarint(singles.length, out);
  singles.forEach(id => writeVarint(id, out));
  writeVarint(doubles.length, out);
  doubles.forEach(id => writeVarint(id, out));
  writeVarint(0, out); // n-copy count

  return Buffer.from(out).toString("base64");
}

// ---------------------------------------------------------------------------
// Learned collection — built passively from game logs

function loadLearnedCollection() {
  if (!fs.existsSync(LEARNED_PATH)) return { cards: {}, games: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(LEARNED_PATH, "utf-8"));
    return { cards: data.cards ?? {}, games: data.games ?? 0 };
  } catch { return { cards: {}, games: 0 }; }
}

function saveLearnedCollection({ cards, games }) {
  ensureDir(LEARNED_PATH);
  fs.writeFileSync(LEARNED_PATH, JSON.stringify({ cards, games, updatedAt: Date.now() }, null, 2));
}

// Merge one game's deck into the persistent learned collection.
// gameDeck: { cardId → { name, count } }
// Returns { added, updated } counts for logging.
function mergeGameDeck(gameDeck) {
  const learned = loadLearnedCollection();
  let added = 0, updated = 0;

  for (const [cardId, { name, count }] of Object.entries(gameDeck)) {
    const existing = learned.cards[cardId];
    if (!existing) {
      learned.cards[cardId] = { name, count, lastSeen: Date.now() };
      added++;
    } else if (count > existing.count) {
      learned.cards[cardId] = { ...existing, name, count, lastSeen: Date.now() };
      updated++;
    } else {
      learned.cards[cardId].lastSeen = Date.now();
    }
  }

  learned.games++;
  saveLearnedCollection(learned);
  return { added, updated, total: Object.keys(learned.cards).length, games: learned.games };
}

module.exports = {
  loadCards,
  fetchCollection, saveCollection, loadCollection,
  decodeDeckCode, encodeDeckCode,
  loadLearnedCollection, saveLearnedCollection, mergeGameDeck,
};
