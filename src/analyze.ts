/**
 * ORI integration — sends game summary + faults to ORI and streams the analysis.
 */

import type { HearthstoneGame } from "./parser";
import type { Fault } from "./faults";
import type { ORIStoneConfig } from "./config";

interface ORIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function buildPrompt(summary: string, faults: Fault[], cardContext: string): string {
  const faultBlock = faults.length === 0
    ? "No mechanical faults pre-detected."
    : faults.map((f) => {
        let line = `[Turn ${f.turn}] [${f.severity.toUpperCase()}/${f.category}] ${f.description}`;
        if (f.correct_line) line += ` Correct line: ${f.correct_line}`;
        return line;
      }).join("\n");

  return `I need you to analyze my Hearthstone game. The parser has already produced a structured summary and a list of pre-detected mechanical faults. Use both to give me a complete turn-by-turn analysis.

---

${summary}

---

## Pre-detected Faults

${faultBlock}

---

${cardContext ? `## Card Context\n\n${cardContext}\n\n---\n\n` : ""}

Please give me the full analysis: turn-by-turn breakdown of key decisions, fault severity assessment, correct lines for each mistake, and a match summary with overall play quality score.`;
}

export async function analyzeWithORI(
  game: HearthstoneGame,
  summary: string,
  faults: Fault[],
  cardContext: string,
  config: ORIStoneConfig,
  onToken: (token: string) => void
): Promise<void> {
  if (!config.oriApiKey) {
    throw new Error("ORI_API_KEY not set. Add it to .env or set the environment variable.");
  }

  const messages: ORIMessage[] = [
    { role: "user", content: buildPrompt(summary, faults, cardContext) },
  ];

  const response = await fetch(`${config.oriApiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.oriApiKey}`,
    },
    body: JSON.stringify({
      model: "",
      stream: true,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ORI API error ${response.status}: ${err}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

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
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data);
        const token = chunk?.choices?.[0]?.delta?.content;
        if (token) onToken(token);
      } catch {
        // skip malformed SSE chunks
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Card context builder — surfaces relevant card info for cards in the game

export function buildCardContext(game: HearthstoneGame, db: import("./cards").CardDB): string {
  const seen = new Set<string>();
  for (const turn of game.turns) {
    for (const action of turn.actions) {
      if (action.card && action.card !== "unknown") seen.add(action.card);
      if (action.target && action.target !== "unknown") seen.add(action.target);
    }
  }

  const lines: string[] = [];
  for (const name of seen) {
    const summary = db.summary(name);
    if (!summary.includes("unknown card")) lines.push(summary);
  }

  return lines.length > 0
    ? `Cards referenced in this game:\n${lines.join("\n")}`
    : "";
}
