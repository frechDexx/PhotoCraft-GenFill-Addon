import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gf", {
  generate: (prompt: string) => ipcRenderer.invoke("gf:generate", prompt),
  show: (i: number) => ipcRenderer.invoke("gf:show", i),
  keep: () => ipcRenderer.invoke("gf:keep"),
  discard: () => ipcRenderer.invoke("gf:discard"),
  cancel: () => ipcRenderer.invoke("gf:cancel"),
  state: () => ipcRenderer.invoke("gf:state"),
  getConfig: () => ipcRenderer.invoke("gf:config:get"),
  setConfig: (patch: unknown) => ipcRenderer.invoke("gf:config:set", patch),
  models: () => ipcRenderer.invoke("gf:models"),
  browse: () => ipcRenderer.invoke("gf:browse"),
  launch: () => ipcRenderer.invoke("gf:launch"),
  probe: () => ipcRenderer.invoke("gf:probe"),
  resize: (h: number) => ipcRenderer.invoke("gf:resize", h),
  hide: () => ipcRenderer.invoke("gf:hide"),
  quit: () => ipcRenderer.invoke("gf:quit"),
  onStatus: (cb: (s: { msg: string; kind: string }) => void) => ipcRenderer.on("gf:status", (_e, s) => cb(s)),
  onFocus: (cb: () => void) => ipcRenderer.on("gf:focus", () => cb()),
});
