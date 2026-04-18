const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ori", {
  send:          (msg) => ipcRenderer.send("ask-ori", msg),
  setInteractive:(v)   => ipcRenderer.send("set-interactive", v),
  getGameState:  ()    => ipcRenderer.send("get-game-state"),
  quit:          ()    => ipcRenderer.send("quit"),
  onToken:       (fn)  => ipcRenderer.on("ori-token",   (_, t) => fn(t)),
  onDone:        (fn)  => ipcRenderer.on("ori-done",    ()     => fn()),
  onError:       (fn)  => ipcRenderer.on("ori-error",   (_, e) => fn(e)),
  onGameState:   (fn)  => ipcRenderer.on("game-state",  (_, s) => fn(s)),
});
