/**
 * Meta cache — runs in main process.
 * Data is fetched by the renderer (Chromium bypasses Cloudflare) and
 * sent here via IPC. We process, cache to disk, and expose a summary
 * string injected into every ORI prompt.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const META_PATH = path.join(os.homedir(), ".config", "oristone", "meta.json");
const META_TTL  = 3 * 60 * 60 * 1000; // 3 hours

const META_URLS = {
  archetypes: "https://hsreplay.net/api/v1/archetypes/?hl=en",
  popularity:  "https://hsreplay.net/analytics/query/archetype_popularity_distribution_stats_v2/?GameType=RANKED_STANDARD&LeagueRankRange=BRONZE_THROUGH_GOLD&Region=ALL&TimeRange=CURRENT_PATCH",
  matchups:    "https://hsreplay.net/analytics/query/head_to_head_archetype_matchups_v2/?GameType=RANKED_STANDARD&LeagueRankRange=BRONZE_THROUGH_GOLD&Region=ALL&TimeRange=CURRENT_PATCH",
  cardStats:   "https://hsreplay.net/analytics/query/card_list_free/?GameType=RANKED_STANDARD&TimeRange=CURRENT_PATCH&LeagueRankRange=BRONZE_THROUGH_GOLD",
};

let metaCache = null;

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function saveMeta(processed) {
  ensureDir(META_PATH);
  fs.writeFileSync(META_PATH, JSON.stringify({ data: processed, fetched_at: Date.now() }, null, 2));
  metaCache = processed;
}

function loadMeta() {
  if (metaCache) return metaCache;
  if (!fs.existsSync(META_PATH)) return null;
  try {
    const { data, fetched_at } = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));
    if (Date.now() - fetched_at > META_TTL) return null;
    metaCache = data;
    return data;
  } catch { return null; }
}

// Loads cached meta ignoring TTL — used by the classifier so archetype detection
// works without Workshop open, as long as meta has been fetched at least once.
function loadMetaStale() {
  if (metaCache) return metaCache;
  if (!fs.existsSync(META_PATH)) return null;
  try {
    const { data } = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));
    return data ?? null;
  } catch { return null; }
}

function isStale() {
  if (!fs.existsSync(META_PATH)) return true;
  try {
    const { fetched_at } = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));
    return Date.now() - fetched_at > META_TTL;
  } catch { return true; }
}

// ---------------------------------------------------------------------------
// Tier assignment

function getTier(winRate, playRate = 0) {
  if (winRate >= 54)                     return "S";
  if (winRate >= 52)                     return "A";
  if (winRate >= 50)                     return "B";
  if (winRate >= 48)                     return "C";
  return "D";
}

// ---------------------------------------------------------------------------
// Signature card extraction from archetype coresets

function extractSignatureCards(archetype) {
  const cards = new Set();
  
  // New HSReplay format: standard_ccp_signature_core.components
  const newStd = archetype.standard_ccp_signature_core?.components;
  if (Array.isArray(newStd)) {
    newStd.forEach(id => cards.add(id));
  }

  // Fallback to old format: standard_coresets
  if (!cards.size) {
    for (const coreset of (archetype.standard_coresets ?? [])) {
      for (const card of (coreset.core_cards ?? [])) {
        if (card.card_id) cards.add(card.card_id);
      }
    }
  }

  // Same for Wild
  const newWild = archetype.wild_ccp_signature_core?.components;
  if (Array.isArray(newWild)) {
    newWild.forEach(id => cards.add(id));
  }
  
  if (!cards.size) {
    for (const coreset of (archetype.wild_coresets ?? [])) {
      for (const card of (coreset.core_cards ?? [])) {
        if (card.card_id) cards.add(card.card_id);
      }
    }
  }

  return [...cards];
}

// ---------------------------------------------------------------------------
// Process raw HSReplay JSON

function processMeta({ archetypes, popularity, matchups, cardStats }, cardDbfMap = {}) {
  console.log("[meta] processing fresh data...");
  
  // Archetype lookup: id → { name, playerClass }
  const archMap = {};
  for (const a of (archetypes ?? [])) {
    archMap[a.id] = { name: a.name, playerClass: a.player_class_name ?? "" };
  }

  // Full archetype list with signature cards (for deck classifier)
  const archetypeList = (archetypes ?? []).map(a => ({
    id:             a.id,
    name:           a.name,
    playerClass:    a.player_class_name ?? "",
    signatureCards: extractSignatureCards(a),
  })).filter(a => a.signatureCards.length > 0);

  // Recursive function to find all arrays in an object
  const findAllArrays = (obj, results = []) => {
    if (!obj || typeof obj !== "object") return results;
    if (Array.isArray(obj)) {
      results.push(obj);
      return results;
    }
    for (const key of Object.keys(obj)) {
      findAllArrays(obj[key], results);
    }
    return results;
  };

  // Popularity rows — find ALL arrays and merge them
  const allPopArrays = findAllArrays(popularity);
  let rows = [];
  for (const arr of allPopArrays) {
    if (arr.length > 0 && (arr[0].archetype_id != null || arr[0].win_rate != null)) {
      rows = rows.concat(arr);
    }
  }

  console.log(`[meta] merged ${rows.length} rows from ${allPopArrays.length} arrays`);

  const normaliseWR = (v) => {
    if (v == null) return 50;
    return v <= 1 ? Math.round(v * 1000) / 10 : Math.round(v * 10) / 10;
  };

  const deckMap = {};
  for (const r of rows) {
    const id = r.archetype_id ?? r.id;
    if (id == null || Number(id) < 0) continue;
    
    const games = r.total_games ?? r.games ?? r.count ?? 0;
    if (!deckMap[id] || games > deckMap[id].games) {
      const arch = archMap[id];
      const wr = normaliseWR(r.win_rate ?? r.winrate);
      deckMap[id] = {
        id,
        name:        arch?.name ?? `Archetype ${id}`,
        playerClass: arch?.playerClass ?? "",
        winRate:     wr,
        playRate:    Math.round((r.pct_of_total ?? 0) * 10) / 10,
        games,
        tier:        getTier(wr),
      };
    }
  }

  const topDecks = Object.values(deckMap)
    .filter(d => d.games >= 5 && archMap[d.id]) // require a real named archetype
    .sort((a, b) => (b.playRate ?? 0) - (a.playRate ?? 0))
    .slice(0, 100);

  console.log(`[meta] finalized ${topDecks.length} top decks`);

  // Matchup table
  const topIds = new Set(topDecks.map(d => String(d.id)));
  const matchupTable = {};
  
  const processMatchupObj = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [atkId, opponents] of Object.entries(obj)) {
      if (!topIds.has(String(atkId)) || !opponents || typeof opponents !== "object" || Array.isArray(opponents)) continue;
      matchupTable[atkId] = matchupTable[atkId] ?? {};
      for (const [defId, stats] of Object.entries(opponents)) {
        if (!topIds.has(String(defId))) continue;
        const wr = stats.win_rate ?? stats.winrate;
        if (wr != null) {
          matchupTable[atkId][defId] = Math.round(normaliseWR(wr) * 10) / 10;
        }
      }
    }
  };

  const scanForMatchups = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const keys = Object.keys(obj);
    const looksLikeMatchup = keys.length > 0 && keys.every(k => !isNaN(k)) && typeof obj[keys[0]] === "object";
    if (looksLikeMatchup) {
      processMatchupObj(obj);
    } else {
      for (const k of keys) scanForMatchups(obj[k]);
    }
  };

  scanForMatchups(matchups);
  console.log(`[meta] matchupTable entries: ${Object.keys(matchupTable).length}`);

  // ---------------------------------------------------------------------------
  // Card stats — top individual cards by win rate
  const topCards = [];
  if (cardStats) {
    try {
      // Response shape varies — find the first array of objects with dbf_id + win_rate
      const findRows = (obj) => {
        if (Array.isArray(obj) && obj.length && obj[0]?.dbf_id != null) return obj;
        if (obj && typeof obj === "object") {
          for (const v of Object.values(obj)) {
            const r = findRows(v);
            if (r) return r;
          }
        }
        return null;
      };
      const rows = findRows(cardStats);
      if (rows) {
        rows
          .filter(r => r.dbf_id && r.win_rate != null && (r.total_games ?? r.popularity ?? 0) > 0)
          .map(r => ({
            dbfId:      r.dbf_id,
            name:       cardDbfMap[r.dbf_id] ?? null,
            winRate:    normaliseWR(r.win_rate),
            playRate:   Math.round((r.popularity ?? r.pct_of_decks ?? 0) * 1000) / 10,
          }))
          .filter(c => c.name && c.winRate >= 51 && c.playRate >= 2)
          .sort((a, b) => b.winRate - a.winRate)
          .slice(0, 20)
          .forEach(c => topCards.push(c));
        console.log(`[meta] topCards: ${topCards.length}`);
      }
    } catch (e) {
      console.warn("[meta] cardStats processing failed:", e.message);
    }
  }

  return { topDecks, matchupTable, archMap, archetypeList, topCards, generatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Deck classifier — matches a card list against archetype signatures

function classifyDeck(deckCardIds, playerClass, meta) {
  if (!meta?.archetypeList?.length || !deckCardIds.length) return null;

  const deckSet = new Set(deckCardIds);

  const scored = meta.archetypeList
    .filter(a => !playerClass || a.playerClass === playerClass || a.playerClass === "")
    .map(a => {
      if (!a.signatureCards.length) return null;
      const hits  = a.signatureCards.filter(id => deckSet.has(id)).length;
      const score = hits / a.signatureCards.length;
      return { ...a, hits, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < 0.25) return null;

  const best  = scored[0];
  const stats = meta.topDecks.find(d => d.id === best.id);

  return {
    id:          best.id,
    name:        best.name,
    playerClass: best.playerClass,
    confidence:  Math.round(best.score * 100),
    winRate:     stats?.winRate ?? null,
    playRate:    stats?.playRate ?? null,
    tier:        stats?.tier ?? null,
  };
}

// ---------------------------------------------------------------------------
// ORI prompt helpers

function buildMetaSummary(meta) {
  if (!meta?.topDecks?.length) return "";

  const byTier = { S: [], A: [], B: [], C: [], D: [] };
  for (const d of meta.topDecks) {
    (byTier[d.tier] ?? byTier.D).push(d);
  }

  const lines = ["Current Hearthstone meta (Standard, ranked ladder):"];
  for (const tier of ["S", "A", "B", "C"]) {
    if (!byTier[tier].length) continue;
    lines.push(`Tier ${tier}:`);
    for (const d of byTier[tier]) {
      lines.push(`  ${d.name} (${d.playerClass}) — ${d.winRate}% WR, ${d.playRate}% playrate`);
    }
  }

  if (meta.topCards?.length) {
    lines.push("High-performing cards this patch:");
    lines.push("  " + meta.topCards.slice(0, 10).map(c => `${c.name} (${c.winRate}% WR)`).join(", "));
  }

  return lines.join("\n");
}

function buildMatchupNote(playerArchetypeId, meta) {
  if (!meta?.matchupTable || !playerArchetypeId) return "";
  const row = meta.matchupTable[String(playerArchetypeId)];
  if (!row) return "";

  const notes = Object.entries(row)
    .map(([oppId, wr]) => {
      const opp = meta.topDecks.find(d => String(d.id) === oppId);
      return opp ? { name: opp.name, wr } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.wr - a.wr);

  if (!notes.length) return "";
  const good = notes.filter(n => n.wr >= 52).map(n => `${n.name} (${n.wr}%)`).join(", ");
  const bad  = notes.filter(n => n.wr <= 48).map(n => `${n.name} (${n.wr}%)`).join(", ");
  const parts = [];
  if (good) parts.push(`Favourable: ${good}`);
  if (bad)  parts.push(`Unfavourable: ${bad}`);
  return parts.join(" | ");
}

module.exports = {
  META_URLS,
  processMeta, saveMeta, loadMeta, loadMetaStale, isStale,
  classifyDeck, getTier,
  buildMetaSummary, buildMatchupNote,
};
