/**
 * Hearthstone Power.log parser
 * Converts raw log text into structured turn-by-turn game state.
 */

export type Zone = "HAND" | "PLAY" | "DECK" | "GRAVEYARD" | "SECRET" | "SETASIDE" | "REMOVEDFROMGAME";
export type Player = "FRIENDLY" | "OPPOSING";

export interface CardAction {
  type:
    | "PLAY"
    | "ATTACK"
    | "POWER"
    | "DRAW"
    | "DEATH"
    | "TRIGGER"
    | "DISCARD"
    | "STEAL"
    | "SUMMON";
  player: Player;
  card: string;
  target?: string;
  value?: number;
  zone_from?: Zone;
  zone_to?: Zone;
}

export interface BoardState {
  friendly_minions: string[];
  opposing_minions: string[];
  friendly_hp: number;
  opposing_hp: number;
  friendly_hand_size: number;
  opposing_hand_size: number;
  friendly_mana: number;
  opposing_mana: number;
}

export interface Turn {
  number: number;
  player: Player;
  actions: CardAction[];
  board_before: Partial<BoardState>;
  board_after: Partial<BoardState>;
  raw_lines: string[];
}

export interface GameResult {
  winner?: Player;
  reason?: "CONCEDE" | "TIMEOUT" | "NORMAL";
}

export interface HearthstoneGame {
  turns: Turn[];
  result?: GameResult;
  parse_warnings: string[];
}

// ---------------------------------------------------------------------------

function extractName(line: string): string | null {
  const m = line.match(/Entity=\[name=([^\]]+)/);
  if (m) return m[1].trim();
  const m2 = line.match(/name=([^\s|]+)/);
  return m2 ? m2[1].trim() : null;
}

function extractBlockType(line: string): string | null {
  const m = line.match(/BLOCK_START BlockType=(\w+)/);
  return m ? m[1] : null;
}

function extractTarget(line: string): string | null {
  const m = line.match(/Target=\[name=([^\]]+)/);
  if (m) return m[1].trim();
  const m2 = line.match(/Target=([^\s|]+)/);
  return m2 ? m2[1] : null;
}

function emptyBoard(): Partial<BoardState> {
  return {
    friendly_minions: [],
    opposing_minions: [],
    friendly_hp: 30,
    opposing_hp: 30,
    friendly_hand_size: 0,
    opposing_hand_size: 0,
    friendly_mana: 0,
    opposing_mana: 0,
  };
}

function cloneBoard(b: Partial<BoardState>): Partial<BoardState> {
  return {
    ...b,
    friendly_minions: [...(b.friendly_minions ?? [])],
    opposing_minions: [...(b.opposing_minions ?? [])],
  };
}

export function parseHearthstoneLog(raw: string): HearthstoneGame {
  const lines = raw.split(/\r?\n/);
  const warnings: string[] = [];
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let currentBoard: Partial<BoardState> = emptyBoard();
  let result: GameResult | undefined;
  let blockStack: Array<{ type: string; actor: string; target?: string }> = [];

  // Track entity metadata
  const entityCardTypes = new Map<number, number>(); // id -> CARDTYPE
  const entityNames = new Map<number, string>(); // id -> Name
  let lastEntityId: number | null = null;

  for (const line of lines) {
    // 1. Track Entity IDs from FULL_ENTITY / SHOW_ENTITY
    const feMatch = line.match(/FULL_ENTITY - Creating ID=(\d+)/);
    const seMatch = line.match(/SHOW_ENTITY - Updating Entity=\[id=(\d+)/);
    if (feMatch || seMatch) {
      lastEntityId = parseInt(feMatch ? feMatch[1] : seMatch![1]);
    }

    // 2. Track CARDTYPE from indented tags
    const cardTypeMatch = line.match(/tag=CARDTYPE value=(\d+)/);
    if (cardTypeMatch && lastEntityId !== null && line.match(/\s+tag=CARDTYPE/)) {
      entityCardTypes.set(lastEntityId, parseInt(cardTypeMatch[1]));
    }

    // 3. Turn boundary
    const turnMatch = line.match(/tag=TURN value=(\d+)/) || line.match(/TurnNumber=(\d+)/);
    if (turnMatch && line.includes("TAG_CHANGE")) {
      const turnNum = parseInt(turnMatch[1]);
      if (!currentTurn || currentTurn.number !== turnNum) {
        if (currentTurn) {
          currentTurn.board_after = cloneBoard(currentBoard);
          turns.push(currentTurn);
        }
        const player: Player = turnNum % 2 === 1 ? "FRIENDLY" : "OPPOSING";
        currentTurn = {
          number: turnNum,
          player,
          actions: [],
          board_before: cloneBoard(currentBoard),
          board_after: {},
          raw_lines: [],
        };
      }
    }

    if (currentTurn) {
      currentTurn.raw_lines.push(line);
    }

    // 4. Block start
    if (line.includes("BLOCK_START")) {
      const blockType = extractBlockType(line);
      const actor = extractName(line) ?? "unknown";
      const target = extractTarget(line) ?? undefined;
      if (blockType && currentTurn) {
        blockStack.push({ type: blockType, actor, target });
        let actionType: CardAction["type"] | null = null;
        switch (blockType) {
          case "PLAY":    actionType = "PLAY";    break;
          case "ATTACK":  actionType = "ATTACK";  break;
          case "POWER":   actionType = "POWER";   break;
          case "TRIGGER": actionType = "TRIGGER"; break;
        }
        if (actionType && actor !== "unknown" && actor !== "GameEntity") {
          const action: CardAction = { type: actionType, player: currentTurn.player, card: actor };
          if (target) action.target = target;
          currentTurn.actions.push(action);
        }
      }
    }

    if (line.includes("BLOCK_END") && blockStack.length > 0) blockStack.pop();

    // 5. Zone changes with CARDTYPE filtering
    const zoneMatch = line.match(/TAG_CHANGE.*Entity=\[id=(\d+)(?:\s+name=([^\]]*))?\].*tag=ZONE value=(\w+)/);
    if (zoneMatch) {
      const [, idStr, nameMatch, zone] = zoneMatch;
      const id = parseInt(idStr);
      const name = (nameMatch || entityNames.get(id) || `Entity #${id}`).trim();
      if (nameMatch) entityNames.set(id, nameMatch.trim());

      const cardType = entityCardTypes.get(id);
      const isMinionOrWeapon = cardType === 4 || cardType === 7;
      // console.log(`DEBUG: Entity ${id} (${name}) type ${cardType} moving to ${zone}`);

      if (zone === "PLAY") {
        if (isMinionOrWeapon) {
          if (currentTurn) {
            const alreadyCaptured = currentTurn.actions.some(
              (a) => a.card === name && (a.type === "PLAY" || a.type === "SUMMON")
            );
            if (!alreadyCaptured) {
              currentTurn.actions.push({ type: "SUMMON", player: currentTurn.player, card: name, zone_to: "PLAY" });
            }
          }
          if (!currentBoard.friendly_minions!.includes(name)) {
            currentBoard.friendly_minions!.push(name);
          }
        }
      }
      if (zone === "GRAVEYARD") {
        currentBoard.friendly_minions = currentBoard.friendly_minions!.filter((m) => m !== name);
        currentBoard.opposing_minions = currentBoard.opposing_minions!.filter((m) => m !== name);
        if (isMinionOrWeapon && currentTurn) {
          currentTurn.actions.push({ type: "DEATH", player: currentTurn.player, card: name, zone_to: "GRAVEYARD" });
        }
      }
      if (zone === "HAND" && currentTurn) {
        const prev = currentTurn.actions[currentTurn.actions.length - 1];
        if (!prev || prev.card !== name || prev.type !== "DRAW") {
          currentTurn.actions.push({ type: "DRAW", player: currentTurn.player, card: name, zone_to: "HAND" });
        }
      }
    }

    // 6. HP tracking
    const hpMatch = line.match(/TAG_CHANGE.*Entity=\[id=(\d+)(?:\s+name=([^\]]*))?\].*tag=HEALTH value=(\d+)/);
    if (hpMatch) {
      const [, idStr, nameMatch, hpStr] = hpMatch;
      const hp = parseInt(hpStr);
      const name = (nameMatch || entityNames.get(parseInt(idStr)) || "").trim();

      // In a real log, we'd ideally identify the hero entities (usually IDs 4 and 64 or similar)
      // For now, we'll keep the simple "FRIENDLY" vs "OPPOSING" name/context check if possible,
      // but also fallback to checking if it's a known hero name if we had that.
      if (line.includes("FRIENDLY") || name === "Friendly Hero") {
        currentBoard.friendly_hp = hp;
      } else if (line.includes("OPPOSING") || name === "Opposing Hero") {
        currentBoard.opposing_hp = hp;
      }
    }

    // 7. Game over
    const goMatch = line.match(/TAG_CHANGE.*Entity=.*tag=PLAYSTATE value=(WON|LOST|CONCEDED|TIED)/);
    if (goMatch) {
      const ps = goMatch[1];
      result = {
        winner: ps === "WON" ? "FRIENDLY" : ps === "LOST" ? "OPPOSING" : undefined,
        reason: ps === "CONCEDED" ? "CONCEDE" : "NORMAL",
      };
    }

  }

  if (currentTurn) {
    currentTurn.board_after = cloneBoard(currentBoard);
    turns.push(currentTurn);
  }

  return { turns, result, parse_warnings: warnings };
}

// ---------------------------------------------------------------------------
// Summarization — prompt-ready context block for ORI

export function summarizeGame(game: HearthstoneGame): string {
  const out: string[] = [];

  out.push("## Hearthstone Game Summary");
  out.push(`Turns played: ${game.turns.length}`);
  if (game.result) {
    const w = game.result.winner ?? "unknown";
    out.push(`Result: ${w} ${game.result.reason === "CONCEDE" ? "conceded" : "won"}`);
  }
  out.push("");

  for (const turn of game.turns) {
    out.push(`### Turn ${turn.number} (${turn.player})`);
    const bb = turn.board_before;
    if (bb.friendly_hp !== undefined) {
      out.push(`Board: Friendly ${bb.friendly_hp}HP [${(bb.friendly_minions ?? []).join(", ") || "empty"}] vs Opposing ${bb.opposing_hp}HP [${(bb.opposing_minions ?? []).join(", ") || "empty"}]`);
    }

    const notable = turn.actions.filter((a) => !(a.type === "DRAW" && a.card === "unknown"));
    if (notable.length === 0) {
      out.push("  (pass / no notable actions)");
    } else {
      for (const a of notable) {
        let line = `  [${a.type}] ${a.card}`;
        if (a.target) line += ` → ${a.target}`;
        if (a.value !== undefined) line += ` (${a.value})`;
        out.push(line);
      }
    }

    const ba = turn.board_after;
    if (ba.friendly_hp !== undefined) {
      out.push(`After: Friendly ${ba.friendly_hp}HP [${(ba.friendly_minions ?? []).join(", ") || "empty"}] vs Opposing ${ba.opposing_hp}HP [${(ba.opposing_minions ?? []).join(", ") || "empty"}]`);
    }
    out.push("");
  }

  if (game.parse_warnings.length > 0) {
    out.push(`**Warnings**: ${game.parse_warnings.join("; ")}`);
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Mechanical fault surface

export interface Fault {
  turn: number;
  severity: "critical" | "major" | "minor";
  description: string;
}

export function surfaceFaults(game: HearthstoneGame): Fault[] {
  const faults: Fault[] = [];

  for (const turn of game.turns) {
    if (turn.player !== "FRIENDLY") continue;

    const plays   = turn.actions.filter((a) => a.type === "PLAY" || a.type === "ATTACK");
    const deaths  = turn.actions.filter((a) => a.type === "DEATH");
    const bb      = turn.board_before;
    const ba      = turn.board_after;

    // Minion played and died same turn without attacking — bad trade / removal target
    for (const p of plays.filter((a) => a.type === "PLAY")) {
      if (deaths.some((d) => d.card === p.card)) {
        faults.push({
          turn: turn.number,
          severity: "minor",
          description: `${p.card} was played and died the same turn — potential unfavorable trade or walked into removal`,
        });
      }
    }

    // Had minions, opponent had minions, no attacks made
    const hadOwnMinions = (bb.friendly_minions?.length ?? 0) > 0;
    const oppHadMinions = (bb.opposing_minions?.length ?? 0) > 0;
    const anyAttack = plays.some((a) => a.type === "ATTACK");
    if (hadOwnMinions && oppHadMinions && !anyAttack) {
      faults.push({
        turn: turn.number,
        severity: "minor",
        description: `Friendly minions sat idle while opponent had board presence — possible tempo loss`,
      });
    }

    // Opponent left at low HP after damage dealt → missed lethal check
    const oppHPBefore = bb.opposing_hp ?? 30;
    const oppHPAfter  = ba.opposing_hp ?? 30;
    const damageDealt = oppHPBefore - oppHPAfter;

    if (oppHPAfter > 0 && oppHPAfter <= 6 && damageDealt > 0) {
      faults.push({
        turn: turn.number,
        severity: "major",
        description: `Opponent left at ${oppHPAfter} HP after taking ${damageDealt} — verify full lethal sequence was not available`,
      });
    }

    // Opponent was in lethal range entering the turn and survived
    if (oppHPBefore <= 6 && oppHPAfter > 0) {
      faults.push({
        turn: turn.number,
        severity: "critical",
        description: `Opponent entered the turn at ${oppHPBefore} HP and survived — likely missed lethal`,
      });
    }
  }

  return faults;
}
