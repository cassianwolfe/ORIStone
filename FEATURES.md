# ORIStone — Feature Ideas

Track of ideas to come back to, roughly in order of priority.

---

## Up Next

### Opponent Archetype Detection
As the opponent plays cards, ORIStone classifies what they're running in real time. Once confident enough, the overlay surfaces the archetype name, its ladder WR, and a quick note on what to watch for in the matchup. Passive — just shows up, no interaction required. The log data is already there; mostly a classifier wiring job against the existing meta archetype list.

### Game Recap
When a match ends, ORI automatically writes a short post-mortem — key turns, what the win/loss condition was, one concrete thing to do differently. Stored per-session so you can review them later. ORI already has full game context; just needs an auto-trigger on game end.

---

## Workshop

### Side-by-Side Deck Compare
Drag two saved decks into a diff view. Shows what's in A but not B and vice versa. Useful when iterating on a list across multiple sessions and trying to remember what changed.

### Tech Card Suggestions
ORI looks at your deck + the current meta tier list and suggests one or two tech slots with reasoning. Example: "Rats are everywhere right now, consider Dirty Rat." Triggered on demand, not automatic.

### Curve + Stat Summary Bar
At the top of the deck builder — a small inline breakdown: avg cost, spell/minion split, early/late game ratio. Numbers only, no extra chart. Quick reference while building.

---

## Overlay

### "What Would You Play?" Mode
A quick-fire button during your turn. One tap, ORI looks at the current board state and gives her top line play. No conversation, just the call. Fast and frictionless.

---

## Longer Term

### Session Stats
Track wins/losses across every game ORIStone observed. Break down by opponent archetype over time — your actual matchup data vs. the ladder average. Starts being useful after ~20–30 tracked games.

### ORI Voice
Text-to-speech for the overlay. ORI calls out notable moments without you having to look away from the board. Probably opt-in.

### Replay Mode
Save the parsed game log and walk through any game turn-by-turn after the fact. Ask ORI questions at any point in the timeline — "should I have traded here instead?"

---

*Start from the top and work down.*
