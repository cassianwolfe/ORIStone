const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ori", {
  send:          (msg, history) => ipcRenderer.send("ask-ori", { message: msg, history }),
  setInteractive:(v)   => ipcRenderer.send("set-interactive", v),
  getGameState:  ()    => ipcRenderer.send("get-game-state"),
  quit:          ()    => ipcRenderer.send("quit"),
  openWorkshop:  ()    => ipcRenderer.send("open-workshop"),
  onToken:        (fn)  => ipcRenderer.on("ori-token",      (_, t) => fn(t)),
  onDone:         (fn)  => ipcRenderer.on("ori-done",       ()     => fn()),
  onError:        (fn)  => ipcRenderer.on("ori-error",      (_, e) => fn(e)),
  onGameState:    (fn)  => ipcRenderer.on("game-state",     (_, s) => fn(s)),
  onOppArchetype:  (fn)  => ipcRenderer.on("opp-archetype",  (_, d) => fn(d)),
  onMulliganStart: (fn)  => ipcRenderer.on("mulligan-start", (_, d) => fn(d)),
  onRecapStart:   (fn)  => ipcRenderer.on("recap-start",    (_, d) => fn(d)),
  onRecapToken:   (fn)  => ipcRenderer.on("recap-token",    (_, t) => fn(t)),
  onRecapDone:    (fn)  => ipcRenderer.on("recap-done",     ()     => fn()),
  onRecapError:   (fn)  => ipcRenderer.on("recap-error",    (_, e) => fn(e)),
});
