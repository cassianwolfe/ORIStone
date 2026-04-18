/**
 * CLI entry point — feed a Power.log file, get structured analysis output.
 *
 * Usage:
 *   bun src/parse.ts path/to/Power.log
 *   bun src/parse.ts path/to/Power.log --json       # raw JSON output
 *   bun src/parse.ts path/to/Power.log --faults     # faults only
 *   bun src/parse.ts path/to/Power.log --summary    # prompt-ready summary
 */

import { readFileSync } from "fs";
import { parseHearthstoneLog, summarizeGame, surfaceFaults } from "./parser";

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
const mode = args.includes("--json")
  ? "json"
  : args.includes("--faults")
  ? "faults"
  : args.includes("--summary")
  ? "summary"
  : "summary"; // default

if (!filePath) {
  console.error("Usage: bun src/parse.ts <Power.log> [--json|--faults|--summary]");
  process.exit(1);
}

const raw = readFileSync(filePath, "utf-8");
const game = parseHearthstoneLog(raw);

switch (mode) {
  case "json":
    console.log(JSON.stringify(game, null, 2));
    break;

  case "faults": {
    const faults = surfaceFaults(game);
    if (faults.length === 0) {
      console.log("No mechanical faults detected.");
      break;
    }
    for (const f of faults) {
      const icon = f.severity === "critical" ? "🔴" : f.severity === "major" ? "🟠" : "🟡";
      console.log(`${icon} Turn ${f.turn} [${f.severity.toUpperCase()}]: ${f.description}`);
    }
    break;
  }

  case "summary":
  default:
    console.log(summarizeGame(game));
    if (game.parse_warnings.length > 0) {
      console.warn("\nParse warnings:", game.parse_warnings.join("\n"));
    }
    break;
}
