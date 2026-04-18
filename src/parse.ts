/**
 * ORIStone CLI
 *
 * Usage:
 *   bun src/parse.ts <Power.log>                  # structured summary
 *   bun src/parse.ts <Power.log> --json           # raw JSON
 *   bun src/parse.ts <Power.log> --faults         # mechanical faults only
 *   bun src/parse.ts <Power.log> --analyze        # full ORI analysis (streams)
 *   bun src/parse.ts --fetch-cards                # force-refresh card DB cache
 */

import { readFileSync } from "fs";
import { parseHearthstoneLog, summarizeGame } from "./parser";
import { CardDB } from "./cards";
import { detectFaults, formatFaults } from "./faults";
import { analyzeWithORI, buildCardContext } from "./analyze";
import { loadConfig } from "./config";

const args = process.argv.slice(2);

// ── fetch-cards ──────────────────────────────────────────────────────────────
if (args.includes("--fetch-cards")) {
  console.log("Fetching card DB...");
  const db = await CardDB.load();
  console.log("Card DB ready.");
  process.exit(0);
}

// ── Main flow ─────────────────────────────────────────────────────────────────
const filePath = args.find((a) => !a.startsWith("--"));
if (!filePath) {
  console.error("Usage: bun src/parse.ts <Power.log> [--json|--faults|--analyze]");
  console.error("       bun src/parse.ts --fetch-cards");
  process.exit(1);
}

const raw  = readFileSync(filePath, "utf-8");
const game = parseHearthstoneLog(raw);
const mode = args.includes("--json")
  ? "json"
  : args.includes("--faults")
  ? "faults"
  : args.includes("--analyze")
  ? "analyze"
  : "summary";

// Load card DB for anything beyond raw JSON
let db: CardDB | null = null;
if (mode !== "json") {
  try {
    db = await CardDB.load();
  } catch (e) {
    console.warn("[warn] Card DB unavailable — falling back to structural analysis only");
  }
}

switch (mode) {
  case "json":
    console.log(JSON.stringify(game, null, 2));
    break;

  case "faults": {
    if (!db) {
      // Fallback: import structural faults from parser
      const { surfaceFaults } = await import("./parser");
      const faults = surfaceFaults(game);
      if (faults.length === 0) {
        console.log("No faults detected.");
      } else {
        for (const f of faults) {
          const icon = f.severity === "critical" ? "🔴" : f.severity === "major" ? "🟠" : "🟡";
          console.log(`${icon} Turn ${f.turn} [${f.severity.toUpperCase()}]: ${f.description}`);
        }
      }
    } else {
      const faults = detectFaults(game, db);
      console.log(formatFaults(faults));
    }
    break;
  }

  case "analyze": {
    const config = loadConfig();
    const summary = summarizeGame(game);
    const faults  = db ? detectFaults(game, db) : [];
    const cardCtx = db ? buildCardContext(game, db) : "";

    console.log("Sending to ORI for analysis...\n");
    process.stdout.write("─".repeat(60) + "\n");

    try {
      await analyzeWithORI(game, summary, faults, cardCtx, config, (token) => {
        process.stdout.write(token);
      });
      process.stdout.write("\n" + "─".repeat(60) + "\n");
    } catch (e: any) {
      console.error("\nAnalysis failed:", e.message);
      process.exit(1);
    }
    break;
  }

  case "summary":
  default:
    console.log(summarizeGame(game));
    if (db) {
      const faults = detectFaults(game, db);
      if (faults.length > 0) {
        console.log("\n## Faults\n");
        console.log(formatFaults(faults));
      }
    }
    break;
}
