/**
 * Enhanced fault detection — uses the card DB for real lethal math,
 * keyword awareness, and mana efficiency analysis.
 */

import type { HearthstoneGame, Turn, CardAction } from "./parser";
import type { CardDB } from "./cards";

export interface Fault {
  turn: number;
  severity: "critical" | "major" | "minor";
  category: "missed_lethal" | "bad_trade" | "tempo" | "sequencing" | "mana" | "mechanic";
  description: string;
  correct_line?: string;
}

// ---------------------------------------------------------------------------
// Lethal calculator

function calculateMaxFaceDamage(
  turn: Turn,
  db: CardDB,
  bonusSpellDamage: number = 0
): number {
  let total = 0;

  // Minion attacks
  const attacks = turn.actions.filter((a) => a.type === "ATTACK");
  for (const atk of attacks) {
    const atk_val = db.attack(atk.card);
    if (atk_val !== null) total += atk_val;
  }

  // Minions on board that didn't attack — could have attacked face
  const boardMinions = turn.board_before.friendly_minions ?? [];
  const attackedCards = new Set(attacks.map((a) => a.card));
  for (const minion of boardMinions) {
    if (!attackedCards.has(minion)) {
      // Check if it has charge/rush (rush can only attack minions on play turn, but minions already on board can go face)
      const atk_val = db.attack(minion);
      if (atk_val !== null) total += atk_val;
    }
  }

  // Spells played that deal damage
  const spells = turn.actions.filter((a) => a.type === "PLAY" && db.isSpell(a.card));
  for (const spell of spells) {
    const card = db.lookup(spell.card);
    if (!card?.text) continue;
    // Parse damage from card text — heuristic: "deal X damage"
    const dmgMatch = card.text.match(/deal (\d+) damage/i);
    if (dmgMatch) {
      total += parseInt(dmgMatch[1]) + bonusSpellDamage;
    }
  }

  return total;
}

function getSpellDamageBonus(turn: Turn, db: CardDB): number {
  let bonus = 0;
  for (const minion of turn.board_before.friendly_minions ?? []) {
    bonus += db.spellDamage(minion);
  }
  return bonus;
}

// ---------------------------------------------------------------------------
// Mana spent this turn

function estimateManaSpent(turn: Turn, db: CardDB): number {
  let spent = 0;
  for (const action of turn.actions) {
    if (action.type === "PLAY") {
      const cost = db.cost(action.card);
      if (cost !== null) spent += cost;
    }
  }
  return spent;
}

// ---------------------------------------------------------------------------
// Main fault detector

export function detectFaults(game: HearthstoneGame, db: CardDB): Fault[] {
  const faults: Fault[] = [];

  for (const turn of game.turns) {
    if (turn.player !== "FRIENDLY") continue;

    const bb = turn.board_before;
    const ba = turn.board_after;
    const plays  = turn.actions.filter((a) => a.type === "PLAY");
    const attacks = turn.actions.filter((a) => a.type === "ATTACK");
    const deaths = turn.actions.filter((a) => a.type === "DEATH");

    const oppHPBefore = bb.opposing_hp ?? 30;
    const oppHPAfter  = ba.opposing_hp ?? 30;
    const spellDmgBonus = getSpellDamageBonus(turn, db);

    // ── Missed lethal ──────────────────────────────────────────────────────

    // Opponent was already in range before our turn
    if (oppHPBefore <= 10 && oppHPAfter > 0) {
      const maxDmg = calculateMaxFaceDamage(turn, db, spellDmgBonus);
      if (maxDmg >= oppHPBefore) {
        faults.push({
          turn: turn.number,
          severity: "critical",
          category: "missed_lethal",
          description: `Opponent at ${oppHPBefore} HP — calculated max face damage this turn: ${maxDmg}. Lethal was likely available.`,
          correct_line: `Attack face with all available damage sources. Check spell damage interactions if bonus applies.`,
        });
      }
    }

    // Opponent reduced to low HP but survived
    if (oppHPAfter > 0 && oppHPAfter <= 4 && oppHPBefore !== oppHPAfter) {
      faults.push({
        turn: turn.number,
        severity: "major",
        category: "missed_lethal",
        description: `Opponent left at ${oppHPAfter} HP — verify whether all face damage was applied in optimal order.`,
        correct_line: `Always verify full lethal math before trading minions that could have gone face.`,
      });
    }

    // ── Bad trades ─────────────────────────────────────────────────────────

    for (const play of plays) {
      const card = db.lookup(play.card);
      if (!card || card.type !== "MINION") continue;

      // Minion died same turn it was played — walked into removal or bad trade
      const diedSameTurn = deaths.some((d) => d.card === play.card);
      if (diedSameTurn) {
        const hasDivineShield = db.hasMechanic(play.card, "DIVINE_SHIELD");
        if (!hasDivineShield) {
          faults.push({
            turn: turn.number,
            severity: "minor",
            category: "bad_trade",
            description: `${play.card} (${card.attack}/${card.health}, cost ${card.cost}) was played and died immediately — walked into removal or unfavorable trade.`,
            correct_line: `Consider playing lower-priority cards first to bait removal, or hold ${play.card} until the threat is gone.`,
          });
        }
      }
    }

    // Attack into a taunt with a more valuable attacker when a weaker one exists
    for (const atk of attacks) {
      if (atk.target && db.hasMechanic(atk.target, "TAUNT")) {
        const atkCard = db.lookup(atk.card);
        const targetCard = db.lookup(atk.target);
        if (atkCard && targetCard) {
          // If attacker dies (health <= target attack) and we have weaker minions available
          const atkDies = (atkCard.health ?? 0) <= (targetCard.attack ?? 0);
          const boardMinions = bb.friendly_minions ?? [];
          const cheaperAttacker = boardMinions.find((m) => {
            if (m === atk.card) return false;
            const mc = db.lookup(m);
            return mc && (mc.attack ?? 0) >= (targetCard.health ?? 0) && (mc.cost ?? 99) < (atkCard.cost ?? 0);
          });
          if (atkDies && cheaperAttacker) {
            faults.push({
              turn: turn.number,
              severity: "minor",
              category: "bad_trade",
              description: `Used ${atk.card} to trade into ${atk.target} (taunt) when ${cheaperAttacker} could handle it and preserve the higher-value minion.`,
              correct_line: `Trade with ${cheaperAttacker} into the taunt, preserve ${atk.card} for a higher-value target or face damage.`,
            });
          }
        }
      }
    }

    // ── Tempo / idle board ─────────────────────────────────────────────────

    const friendlyHadMinions = (bb.friendly_minions?.length ?? 0) > 0;
    const oppHadMinions      = (bb.opposing_minions?.length ?? 0) > 0;
    const anyAttack          = attacks.length > 0;

    if (friendlyHadMinions && oppHadMinions && !anyAttack && plays.length > 0) {
      faults.push({
        turn: turn.number,
        severity: "minor",
        category: "tempo",
        description: `Friendly minions did not attack despite opponent having board presence.`,
        correct_line: `Attack with existing minions before or after playing new ones — especially if opponent has a snowball threat.`,
      });
    }

    // ── Mana efficiency ────────────────────────────────────────────────────

    if (plays.length === 0 && attacks.length === 0 && (bb.friendly_mana ?? 0) > 2) {
      faults.push({
        turn: turn.number,
        severity: "minor",
        category: "mana",
        description: `Turn passed with no plays or attacks and mana available — complete pass without a reactive justification.`,
        correct_line: `In most cases, spending mana is correct. Holding mana is only justified when holding a specific counter or secret.`,
      });
    }

    // ── Sequencing ─────────────────────────────────────────────────────────

    // Played a card that generates resources AFTER spending all mana
    const resourceGenerators = plays.filter((p) => {
      const text = db.lookup(p.card)?.text ?? "";
      return /draw a card|discover|add.*to your hand/i.test(text);
    });
    const manaSpenders = plays.filter((p) => (db.cost(p.card) ?? 0) >= 3);
    if (resourceGenerators.length > 0 && manaSpenders.length > 0) {
      const genIdx   = plays.findIndex((p) => resourceGenerators.some((r) => r.card === p.card));
      const spendIdx = plays.findIndex((p) => manaSpenders.some((s) => s.card === p.card));
      if (genIdx > spendIdx) {
        const gen = resourceGenerators[0];
        faults.push({
          turn: turn.number,
          severity: "minor",
          category: "sequencing",
          description: `${gen.card} (draws/discovers) was played after higher-cost cards — the drawn card could not be used this turn.`,
          correct_line: `Play draw/discover effects before spending mana so the new card can be played if mana allows.`,
        });
      }
    }

    // Divine shield minion attacked a weak minion when a larger threat existed
    for (const atk of attacks) {
      if (!db.hasMechanic(atk.card, "DIVINE_SHIELD")) continue;
      if (!atk.target) continue;
      const targetCard = db.lookup(atk.target);
      const oppBoard = bb.opposing_minions ?? [];
      const biggerThreat = oppBoard.find((m) => {
        if (m === atk.target) return false;
        const mc = db.lookup(m);
        return (mc?.attack ?? 0) > (targetCard?.attack ?? 0) && db.hasMechanic(m, "DIVINE_SHIELD") === false;
      });
      if (biggerThreat) {
        faults.push({
          turn: turn.number,
          severity: "minor",
          category: "mechanic",
          description: `${atk.card} (Divine Shield) popped its shield on ${atk.target} — ${biggerThreat} was a higher-value target to trade the shield against.`,
          correct_line: `Prioritize popping divine shields on your opponent's minions and using your divine shield minion against their strongest threat.`,
        });
      }
    }
  }

  return faults;
}

export function formatFaults(faults: Fault[]): string {
  if (faults.length === 0) return "No mechanical faults detected.";
  const icon = (s: Fault["severity"]) =>
    s === "critical" ? "🔴" : s === "major" ? "🟠" : "🟡";
  return faults
    .map((f) => {
      let line = `${icon(f.severity)} Turn ${f.turn} [${f.severity.toUpperCase()}/${f.category}]: ${f.description}`;
      if (f.correct_line) line += `\n   → ${f.correct_line}`;
      return line;
    })
    .join("\n\n");
}
