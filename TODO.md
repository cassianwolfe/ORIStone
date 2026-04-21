# ORIStone — TODO

## Completed This Session

### Design System
- [x] Full CSS token system — `--primary`, `--secondary`, `--text`, `--surface` stack, motion tokens
- [x] Warm woodgrain palette — dark walnut backgrounds (`#120e08` → `#2e2418`), HS gold primary (`#d4a030`), copper secondary (`#e8763a`)
- [x] Gold interaction depth — `--primary-hi` (hover), `--primary-lo` (active), no gradients
- [x] Radial vignette on workshop — center-lit feel
- [x] Full teal purge — replaced all `rgba(129,230,217,...)` and `#81e6d9` across both files
- [x] Lucide icons throughout — replaced emoji icons in nav, workshop button, etc.

### Workshop UI
- [x] OS-style sidebar nav — 6 sections (Workshop, Meta, Collection, Journal, ORI, Settings)
- [x] ORI as its own section — no longer fights meta panel for space
- [x] Floating ORI orb — bottom-right of workshop, gold glow, popover with last response + quick-ask
- [x] ORI suggestion cards — 6 cards on empty ORI section state
- [x] ORI thinking phrases — cycling italic flavor text before first token (workshop: deep/lore; in-game: snappy/tactical)
- [x] Favs tab — rebuilt as slim list rows (click to load, hover-only trash icon)
- [x] Stats panel — stat tiles with surfaces, gold-accent section labels, matchup bars with track + fill, tier group dividers
- [x] Home tab — warm hovers throughout, gold mana curve bars, warm FREE/COMMON mana gems, deck button hovers

### In-Game Overlay (bubble.html)
- [x] Orb uses `Orb1.png` — warm gold glow on hover/active
- [x] Panel background updated to warm dark (`rgba(24,21,16,0.96)`)
- [x] All blues replaced — send button, user bubbles, borders all gold
- [x] ORI thinking phrases — snappier tactical set
- [x] Duplicate CSS rules cleaned up

### ORI Logic
- [x] System prompt rewritten — explicit intent mapping (build/create → deck block; add/remove/swap → edit block), consequence stated
- [x] History now stores full response including code blocks — ORI remembers what she built
- [x] Edit no-op now surfaces a visible system note instead of silent failure

---

## Pending Technical Debt

- [ ] **DevTools left open** — `workshopWin.webContents.openDevTools({ mode: "detach" })` still in `main.js:693`. Remove before any release/demo.
- [ ] **`no-cache` header on workshop load** — `main.js:692` uses `extraHeaders: "pragma: no-cache\n"` added for debugging. Remove or gate behind `--dev` flag.
- [ ] **ORI section nav icon** — currently using a generic message-square SVG inline. Should use Lucide properly once Lucide is confirmed loading in nav (nav uses inline SVG, rest uses `data-lucide`).
- [ ] **Light mode stub** — `[data-theme="light"]` in `:root` is incomplete — several tokens not overridden. Either finish it or remove the block.
- [ ] **Collection section** — stub only, no content. `collection.js` exists but integration unknown.
- [ ] **Journal section** — stub only, no content.
- [ ] **Settings section** — stub only, no content.
- [ ] **`auth.js`** — still has hardcoded `#0d101a` / `#90cdf4` cold colors. Not on critical path but out of palette.
- [ ] **Duplicate `.deck-btn.primary:active`** rule was cleaned up this session — audit for any other duplicate CSS rules remaining.
- [ ] **`allCards` empty edge case** — `applyDeckEdit` and `tryBuildDeckFromResponse` silently skip unknown cards. The new system note helps but root cause (card DB not loaded?) should be investigated if ORI edits still fail.

---

## Immediate Next Steps

### ORI Functionality
- [x] **Test deck build + edit flow** — confirmed solid
- [ ] **Verify card name matching** — ORI sometimes uses slightly different card names than the DB. May need fuzzy match improvement in `tryBuildDeckFromResponse` / `applyDeckEdit`

### Features (from FEATURES.md priority order)
- [ ] **Opponent archetype detection** — log data is already parsed, needs classifier wired to meta archetype list + overlay display
- [ ] **Game recap** — auto-trigger on game end, ORI writes post-mortem; context already available

### Workshop Features
- [ ] **Tech Card Suggestions** — ORI looks at deck + meta tier list, suggests 1-2 tech slots with reasoning. On-demand, not automatic.
- [ ] **Side-by-Side Deck Compare** — diff view for two saved decks, shows what's in A but not B
- [ ] **Curve + stat summary bar** — small inline breakdown at top of deck builder (avg cost, spell/minion split)

### Overlay Features
- [ ] **"What Would You Play?" Mode** — one-tap button during your turn, ORI gives top line play instantly, no conversation

### Polish
- [ ] **Remove debug DevTools call** from `main.js` before next demo
- [ ] **Collection section** — wire `collection.js` to the nav section
