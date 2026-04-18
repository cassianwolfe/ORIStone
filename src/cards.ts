/**
 * Hearthstone card database — fetches from HearthstoneJSON, caches locally.
 * Provides lookup by name and mechanical queries (spell damage, keywords, cost).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CARD_DB_URL = "https://api.hearthstonejson.com/v1/latest/enUS/cards.json";
const CACHE_DIR   = join(import.meta.dir, "../data");
const CACHE_PATH  = join(CACHE_DIR, "cards.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

export type CardType = "MINION" | "SPELL" | "WEAPON" | "HERO" | "HERO_POWER" | "ENCHANTMENT" | "LOCATION";
export type Mechanic =
  | "TAUNT" | "DIVINE_SHIELD" | "WINDFURY" | "CHARGE" | "RUSH" | "LIFESTEAL"
  | "POISONOUS" | "REBORN" | "STEALTH" | "DEATHRATTLE" | "BATTLECRY" | "COMBO"
  | "OUTCAST" | "SPELLBURST" | "DISCOVER" | "INSPIRE" | "MEGA_WINDFURY"
  | "IMMUNE" | "FREEZE" | "SILENCE" | "OVERLOAD" | "SPELL_DAMAGE"
  | (string & {}); // allow unknown mechanics

export interface HSCard {
  id: string;
  name: string;
  cost: number;
  type: CardType;
  attack?: number;
  health?: number;
  durability?: number;
  text?: string;           // card text with HTML stripped
  mechanics?: Mechanic[];
  spellDamage?: number;    // +spell damage value if any
  classes?: string[];
  set?: string;
  rarity?: string;
  collectible?: boolean;
}

// ---------------------------------------------------------------------------
// Fetch + cache

async function fetchCardDB(): Promise<HSCard[]> {
  console.error("[cards] Fetching card DB from HearthstoneJSON...");
  const res = await fetch(CARD_DB_URL);
  if (!res.ok) throw new Error(`Failed to fetch card DB: ${res.status}`);
  const raw: any[] = await res.json();

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(raw, null, 2));
  console.error(`[cards] Cached ${raw.length} cards to ${CACHE_PATH}`);
  return parseCards(raw);
}

function parseCards(raw: any[]): HSCard[] {
  return raw
    .filter((c) => c.name && c.cost !== undefined)
    .map((c) => ({
      id:          c.id,
      name:        c.name,
      cost:        c.cost ?? 0,
      type:        c.type as CardType,
      attack:      c.attack,
      health:      c.health,
      durability:  c.durability,
      text:        c.text?.replace(/<[^>]+>/g, "").replace(/\[x\]/g, "").trim(),
      mechanics:   c.mechanics ?? [],
      spellDamage: c.spellDamage,
      classes:     c.classes ?? (c.cardClass ? [c.cardClass] : []),
      set:         c.set,
      rarity:      c.rarity,
      collectible: c.collectible,
    }));
}

// ---------------------------------------------------------------------------
// CardDB class

export class CardDB {
  private byName: Map<string, HSCard>;
  private byId: Map<string, HSCard>;

  private constructor(cards: HSCard[]) {
    this.byName = new Map();
    this.byId   = new Map();
    for (const c of cards) {
      this.byId.set(c.id, c);
      // Lowercase + trim for fuzzy name lookup
      const key = c.name.toLowerCase().trim();
      // Prefer collectible cards when name collides
      if (!this.byName.has(key) || c.collectible) {
        this.byName.set(key, c);
      }
    }
  }

  static async load(): Promise<CardDB> {
    let raw: any[];
    if (existsSync(CACHE_PATH)) {
      const stat = Bun.file(CACHE_PATH).size;
      const mtime = (await Bun.file(CACHE_PATH).stat?.()) ?? null;
      // Check age via file mtime
      const age = Date.now() - (existsSync(CACHE_PATH)
        ? (await import("fs")).statSync(CACHE_PATH).mtimeMs
        : 0);
      if (age < CACHE_TTL_MS) {
        raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
        console.error(`[cards] Loaded ${raw.length} cards from cache`);
        return new CardDB(parseCards(raw));
      }
    }
    return new CardDB(await fetchCardDB());
  }

  lookup(name: string): HSCard | null {
    return this.byName.get(name.toLowerCase().trim()) ?? null;
  }

  lookupById(id: string): HSCard | null {
    return this.byId.get(id) ?? null;
  }

  hasMechanic(name: string, mechanic: Mechanic): boolean {
    const card = this.lookup(name);
    return card?.mechanics?.includes(mechanic) ?? false;
  }

  cost(name: string): number | null {
    return this.lookup(name)?.cost ?? null;
  }

  attack(name: string): number | null {
    return this.lookup(name)?.attack ?? null;
  }

  health(name: string): number | null {
    return this.lookup(name)?.health ?? null;
  }

  isSpell(name: string): boolean {
    return this.lookup(name)?.type === "SPELL";
  }

  isMinion(name: string): boolean {
    return this.lookup(name)?.type === "MINION";
  }

  spellDamage(name: string): number {
    return this.lookup(name)?.spellDamage ?? 0;
  }

  summary(name: string): string {
    const c = this.lookup(name);
    if (!c) return `${name} (unknown card)`;
    const parts: string[] = [`${c.name} [${c.type}] cost:${c.cost}`];
    if (c.attack !== undefined) parts.push(`${c.attack}/${c.health}`);
    if (c.mechanics?.length) parts.push(c.mechanics.join(", "));
    if (c.text) parts.push(`"${c.text.slice(0, 80)}${c.text.length > 80 ? "…" : ""}"`);
    return parts.join(" | ");
  }
}
