const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workshop", {
  // Card data
  getCards:           ()       => ipcRenderer.invoke("ws:get-cards"),

  // Collection / auth
  getStatus:          ()       => ipcRenderer.invoke("ws:status"),
  authenticate:       ()       => ipcRenderer.invoke("ws:authenticate"),
  syncCollection:     ()       => ipcRenderer.invoke("ws:sync-collection"),

  // Deck codes
  importDeck:         (code)   => ipcRenderer.invoke("ws:import-deck", code),
  exportDeck:         (deck)   => ipcRenderer.invoke("ws:export-deck", deck),

  // Saved decks
  loadDecks:          ()       => ipcRenderer.invoke("ws:load-decks"),
  saveDecks:          (decks)  => ipcRenderer.invoke("ws:save-decks", decks),

  // ORI chat (deck context)
  askORI:             (msg, deck, history) => ipcRenderer.send("ws:ask-ori", { message: msg, deck, history }),

  // Meta — renderer fetches (bypasses Cloudflare), sends raw JSON to main
  getMetaURLs:        ()               => ipcRenderer.invoke("ws:meta-urls"),
  getMeta:            ()               => ipcRenderer.invoke("ws:get-meta"),
  sendMetaData:       (raw)            => ipcRenderer.send("ws:meta-data", raw),
  getMetaStatus:      ()               => ipcRenderer.invoke("ws:meta-status"),
  classifyDeck:       (ids, cls)       => ipcRenderer.invoke("ws:classify-deck", { ids, cls }),

  // Events → renderer
  onORIToken:         (cb) => ipcRenderer.on("ws:ori-token",         (_, t) => cb(t)),
  onORIDone:          (cb) => ipcRenderer.on("ws:ori-done",          ()     => cb()),
  onORIError:         (cb) => ipcRenderer.on("ws:ori-error",         (_, e) => cb(e)),
  onCollectionLoaded: (cb) => ipcRenderer.on("ws:collection-loaded", (_, d) => cb(d)),
  onCardsReady:       (cb) => ipcRenderer.on("ws:cards-ready",       (_, d) => cb(d)),
  onMetaReady:        (cb) => ipcRenderer.on("ws:meta-ready",        (_, d) => cb(d)),

  close: () => ipcRenderer.send("ws:close"),
});
