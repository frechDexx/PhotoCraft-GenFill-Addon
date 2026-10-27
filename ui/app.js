"use strict";
// `gf` is the bridge exposed by preload.js; don't redeclare that global name here.
const $ = (id) => document.getElementById(id);
const api = window.gf;

const el = {
  root: $("root"), prompt: $("prompt"), go: $("go"), menu: $("menu"), close: $("close"),
  status: $("status"), variants: $("variants"), strip: $("strip"),
  keep: $("keep"), discard: $("discard"), settings: $("settings"),
};

let busy = false;

/** Resize the frameless window to its content. */
function fit() {
  requestAnimationFrame(() => api.resize(el.root.scrollHeight + 2));
}

function setStatus(msg, kind = "info", spinning = false) {
  el.status.hidden = !msg;
  el.status.className = `status ${kind}`;
  el.status.textContent = "";
  if (spinning) {
    const s = document.createElement("span");
    s.className = "spinner";
    el.status.append(s);
  }
  el.status.append(document.createTextNode(msg || ""));
  if (spinning) {
    const c = document.createElement("button");
    c.className = "cancel";
    c.textContent = "Cancel";
    c.onclick = () => api.cancel();
    el.status.append(c);
  }
  fit();
}

function setBusy(b) {
  busy = b;
  for (const btn of [el.go, el.keep, el.discard]) btn.disabled = b;
  el.go.textContent = b ? "Working …" : "Generate";
}

function render(state) {
  el.strip.textContent = "";
  const vs = state?.variants ?? [];
  el.variants.hidden = vs.length === 0;
  vs.forEach((v, i) => {
    const t = document.createElement("div");
    t.className = "thumb" + (i === state.active ? " active" : "");
    t.style.backgroundImage = `url("${v.thumb}")`;
    t.title = v.prompt || "Remove";
    const n = document.createElement("span");
    n.textContent = String(i + 1);
    t.append(n);
    t.onclick = async () => {
      if (busy) return;
      const r = await api.show(i);
      if (r.ok) render(r.data);
    };
    el.strip.append(t);
  });
  fit();
}

async function run(fn, label) {
  if (busy) return;
  setBusy(true);
  if (label) setStatus(label, "info", true);
  try {
    const r = await fn();
    if (r && r.ok) render(r.data);
  } finally {
    setBusy(false);
  }
}

el.go.onclick = () => run(() => api.generate(el.prompt.value), "Starting …");
el.keep.onclick = () => run(() => api.keep());
el.discard.onclick = () => run(() => api.discard());
el.close.onclick = () => api.hide();

el.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.go.click();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.hide();
  if (!el.variants.hidden && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const thumbs = [...el.strip.children];
    const cur = thumbs.findIndex((t) => t.classList.contains("active"));
    const next = (cur + (e.key === "ArrowRight" ? 1 : -1) + thumbs.length) % thumbs.length;
    thumbs[next]?.click();
  }
});

api.onStatus(({ msg, kind }) => setStatus(msg, kind, busy && kind === "info"));
api.onFocus(() => {
  el.prompt.focus();
  el.prompt.select();
});

// ---- settings -----------------------------------------------------------------------------------
function fillModels(models, current) {
  const sel = $("s-model");
  const all = [...new Set([current, ...models].filter(Boolean))];
  sel.textContent = "";
  for (const m of all) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.append(o);
  }
  sel.value = current;
}

async function loadSettings() {
  const c = await api.getConfig();
  $("s-key").value = c.geminiApiKey;
  fillModels([], c.model);
  $("s-variants").value = c.variants;
  $("s-padding").value = c.contextPadding;
  $("s-size").value = c.imageSize || "";
  $("s-hotkey").value = c.hotkey;
  $("s-dir").value = c.photocraftDir;
  $("s-launch").checked = !!c.launchPhotoCraft;
  $("s-port").value = c.controlPort;
  $("s-root").value = c.automationRoot;
  if (!c.geminiApiKey || !c.photocraftDir) {
    el.settings.hidden = false;
    setStatus(!c.photocraftDir ? "First run: choose your PhotoCraft folder and enter your Gemini API key, then Save." : "Enter your Gemini API key, then Save.");
  }
  fit();
}

el.menu.onclick = () => {
  el.settings.hidden = !el.settings.hidden;
  fit();
};

$("s-save").onclick = async () => {
  const r = await api.setConfig({
    geminiApiKey: $("s-key").value.trim(),
    model: $("s-model").value,
    variants: Number($("s-variants").value),
    contextPadding: Number($("s-padding").value),
    imageSize: $("s-size").value,
    hotkey: $("s-hotkey").value.trim(),
    photocraftDir: $("s-dir").value.trim(),
    launchPhotoCraft: $("s-launch").checked,
    controlPort: Number($("s-port").value),
    automationRoot: $("s-root").value.trim(),
  });
  if (r.ok) {
    setStatus("Saved.", "done");
    await loadSettings();
  }
};

$("s-browse").onclick = async () => {
  const r = await api.browse();
  if (r.ok && r.data) $("s-dir").value = r.data;
};

$("s-models").onclick = async () => {
  setStatus("Loading models …");
  const r = await api.models();
  if (!r.ok) return;
  fillModels(r.data, $("s-model").value);
  setStatus(r.data.length ? `${r.data.length} image models available. Pick one and Save.` : "No image models found for this key.", "done");
};

$("s-start").onclick = async () => {
  const r = await api.launch();
  if (r.ok) setStatus(r.data, "done");
};

$("s-probe").onclick = async () => {
  setStatus("Testing connection …");
  const r = await api.probe();
  if (r.ok) setStatus(`Connected. Report: ${r.data}`, "done");
};

$("s-quit").onclick = () => api.quit();

loadSettings();
api.state().then(render);
el.prompt.focus();
