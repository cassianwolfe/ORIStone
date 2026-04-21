# ORIStone — CLAUDE.md

## Communication Style
- **Tone**: Professional but casual peer-to-peer collaborator. Think "Senior Dev pair-programming."
- **Directness**: Be concise. Skip the formal "I can help with that" or "As an AI..." fluff. 
- **Opinionated**: If my approach is sub-optimal, call it out and suggest a better way like a teammate would.
- **Context**: Use technical shorthand and assume I'm competent. Don't over-explain basic concepts unless asked.
- **Vibe**: Keep it conversational. It’s okay to use developer slang, emojis occasionally, or dry humor.


## What This Is

Electron desktop overlay for Hearthstone. Two windows:
- `overlay/bubble.html` — in-game floating orb + chat panel (always on top, transparent bg)
- `overlay/workshop.html` — full Workshop OS (deck builder, meta, ORI chat, collection, journal)

Main process: `overlay/main.js`. Renderer ↔ main via `contextBridge` / IPC.
No React, no bundler. Vanilla HTML/CSS/JS in renderers.

---

## Project Structure

```
overlay/
  main.js              # Electron main — IPC, ORI API calls, log watching
  bubble.html          # In-game overlay
  workshop.html        # Workshop OS
  preload.js           # bubble.html bridge (ori.*)
  workshop-preload.js  # workshop.html bridge (workshop.*)
  collection.js        # Collection logic (partially wired)
  auth.js              # Blizzard OAuth
  meta.js              # Meta fetch helpers
images/
  Orb1.png             # In-game orb face
  Orb2.png             # Workshop orb face
src/
  parse.ts             # Power.log parser
  analyze.ts           # ORI analysis
  cards.ts             # Card DB helpers
  faults.ts            # Fault detection
```

---

## Design System

All colors and motion are CSS custom properties. Never hardcode a color that belongs to the palette.

### Tokens (both files must stay in sync)

```css
/* Surfaces — warm walnut stack */
--bg:              #120e08;
--surface:         #1c1610;
--surface-raised:  #241d14;
--surface-overlay: #2e2418;

/* Borders — warm-tinted */
--border:          rgba(255,220,150,0.08);
--border-strong:   rgba(255,220,150,0.15);
--border-focus:    rgba(212,160,48,0.5);

/* Brand */
--primary:         #d4a030;   /* HS gold — primary accent, ORI brand */
--primary-hi:      #e0b840;   /* hover state — slightly brighter */
--primary-lo:      #b08828;   /* active/press state — slightly darker */
--primary-dim:     rgba(212,160,48,0.12);
--primary-hover:   rgba(212,160,48,0.2);
--secondary:       #e8763a;   /* warm copper — card borders, secondary accent */
--secondary-dim:   rgba(232,118,58,0.12);

/* Text */
--text:            #f2e6cc;   /* warm parchment */
--text-muted:      #a08860;   /* warm tan */
--text-faint:      #6a5540;   /* dark tan */

/* Semantic */
--danger:  #fc8181;
--success: #68d391;
--warning: #f6ad55;

/* Motion */
--t-fast: 0.1s ease;
--t-base: 0.15s ease;
--t-slow: 0.25s ease;
```

### What stays blue (intentional, game-canon)
- Mana gems for RARE/EPIC/LEGENDARY cards
- Tier-B badge
- `.slot-mana` (mana crystal in deck list)
- Win/loss colors use `--success` / `--danger` (green/red), not gold

### Gold interaction depth rule
No gradients for interactive states. Use the three gold levels only:
- Default: `var(--primary)` — `#d4a030`
- Hover: `var(--primary-hi)` — `#e0b840`
- Active/press: `var(--primary-lo)` — `#b08828`

### Hover convention
All hover background tints use warm gold, never cold white:
- Subtle: `rgba(212,160,48,0.05–0.08)`
- Medium: `rgba(212,160,48,0.12)` (= `--primary-dim`)

---

## Architecture Patterns

### IPC flow (workshop)
```
renderer: workshop.askORI(msg, { cards: [...] }, history)
  → ipcRenderer.send("ws:ask-ori", { message, deck, history })
    → ipcMain: askORIWorkshop(message, deck, history, workshopWin)
      → streams tokens back via workshopWin.webContents.send("ws:ori-token", token)
```

### ORI streaming state (both renderers)
```javascript
let isStreaming = false;
let streamTarget = null;       // the .msg-bubble DOM node being written to
let awaitingFirstToken = false; // true until first token clears thinking phrases
let thinkingTimer = null;
```

Sequence: `startThinking(bub)` → first token → `stopThinking(bub)` + add cursor → tokens stream → `ori-done` → remove cursor.

### ORI deck actions (workshop only)
ORI returns two possible code blocks in her response:
- ` ```deck ` — full 30-card JSON array → replaces entire deck
- ` ```edit ` — add/remove ops array → patches current deck

Parsed in `tryBuildDeckFromResponse()` and `applyDeckEdit()` on `ori-done`.
Code blocks are hidden from chat display but **kept in chat history** so ORI remembers what she built.

### ORI system prompt intent mapping
- "build / create / suggest / recommend a deck" → **deck block** (replaces current deck)
- "add / remove / swap / tweak / optimize / improve" → **edit block** (patches current deck)

If ORI makes a change without a block, nothing is applied. The prompt states this explicitly.

---

## Editing Rules

### Layered edits — never full rewrites
Both `workshop.html` and `bubble.html` are large. Always use targeted `Edit` calls. Never rewrite a whole file in one shot.

### Both files must stay in sync
Any change to the design token values (`:root`) must be applied to **both** `workshop.html` and `bubble.html`.

### No cold colors in new UI chrome
Check new CSS before committing — no `rgba(255,255,255,0.X)` hovers, no hardcoded navy/blue for UI chrome. Cold colors are only acceptable for game-canon elements (mana, rarity).

### ORI thinking phrases
- Workshop (`ORI_THINKING`): deep, lore-y, meta-strategic flavor
- In-game (`ORI_THINKING`): short, tactical, in-the-moment

---

## Known Debug State (clean up before demo)

```javascript
// main.js:692 — remove before release
workshopWin.loadFile("workshop.html", { extraHeaders: "pragma: no-cache\n" });

// main.js:693 — remove before release
workshopWin.webContents.openDevTools({ mode: "detach" });
```
