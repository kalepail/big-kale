/* Big Kale client — canvas farm, you do not path units. */
const MAP_W = 48, MAP_H = 48, TILE = 28;
const JOBS = [
  { id: "planter", label: "Planter", hire: 10, burn: 0.4 },
  { id: "worker", label: "Worker", hire: 15, burn: 0.6 },
  { id: "harvester", label: "Harvester", hire: 15, burn: 0.55 },
  { id: "hauler", label: "Hauler", hire: 12, burn: 0.4 },
  { id: "builder", label: "Builder", hire: 20, burn: 0.9 },
];
const BAND = { planter: "#7cfc00", worker: "#f4d35e", harvester: "#e85d04", hauler: "#4cc9f0", builder: "#b5651d" };
const DES_COL = { plant: "124,252,0", tend: "244,211,94", harvest: "232,93,4", haul: "76,201,240", build: "181,101,29" };
const ROMAN = ["I", "II", "III", "IV", "V"];
function pailRank(a) {
  const r = Math.max(1, Math.min(5, Math.floor(a?.rank || 1)));
  return r;
}
function pailTitle(a) {
  return "Pail " + ROMAN[pailRank(a) - 1];
}


const canvas = document.getElementById("farm");
const mini = document.getElementById("minimap");
const ctx = canvas.getContext("2d");
const mctx = mini.getContext("2d");
ctx.imageSmoothingEnabled = false;
mctx.imageSmoothingEnabled = false;

const vis = new Map();
const hudEl = {
  kale: document.getElementById("hud-kale"),
  yield: document.getElementById("hud-yield"),
  spend: document.getElementById("hud-spend"),
  net: document.getElementById("hud-net"),
  statNet: document.getElementById("stat-net"),
  agents: document.getElementById("hud-agents"),
  idle: document.getElementById("hud-idle"),
  unused: document.getElementById("hud-unused"),
  staff: document.getElementById("hud-staff"),
  line: document.getElementById("hud-line"),
  statLine: document.getElementById("stat-line"),
  btnIdle: document.getElementById("btn-idle"),
  alerts: document.getElementById("alerts"),
  thought: document.getElementById("foreman-thought"),
  farmfile: document.getElementById("farmfile"),
  toast: document.getElementById("toast"),
};

const cam = { x: 20 * TILE, y: 16 * TILE, z: 1.15 };
const keys = new Set();
let tool = "plant";
let paintOn = false;
let paintDrag = null;
let drag = null;
let selected = null;
let inspectSig = "";
let lastTile = { x: 26, y: 22 };
let idleCycle = 0;
let ws = null;
let map = { w: MAP_W, h: MAP_H, terrain: new Array(MAP_W * MAP_H).fill(0), barn: { x: 21, y: 18, w: 3, h: 3 }, well: { x: 18, y: 20 } };
let snap = null;
let toastTimer = 0;
let didCenter = false;
let wsToastShown = false;
let wsTimer = null;
let polling = false;
let pollQueued = false;
let greeted = false;
let awaitingSnap = true;
const pendingDes = new Map();

function resize() {
  const stage = document.getElementById("stage");
  canvas.width = stage.clientWidth;
  canvas.height = stage.clientHeight;
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener("resize", resize);
resize();

function applyWorld(data) {
  if (!data || typeof data !== "object") return;
  if (data.map && data.map.type === "map") map = data.map;
  else if (data.type === "map") map = data;
  const next = data.snap && data.snap.type === "snap" ? data.snap : data.type === "snap" ? data : null;
  if (next) {
    const first = !snap;
    snap = next;
    syncVis(next.agents);
    reconcilePending();
    paintHud();
    if (first || !didCenter) centerOnFirstSnap();
    if (first) {
      const farmfile = document.getElementById("farmfile");
      if (farmfile && document.activeElement !== farmfile) farmfile.value = next.rootPrompt || "";
    }
    refreshInspect();
  }
  if (!greeted && snap) {
    greeted = true;
    awaitingSnap = false;
    const kale = snap.hud?.kale ?? 0;
    const n = snap.hud?.agents ?? snap.agents?.length ?? 0;
    if (kale > 100 || n > 1) {
      toast(`connected to kale-1. ${n} pails. ${kale.toFixed(0)} kale.`);
    } else {
      toast("connected to kale-1. one planter. forty kale. write a file.");
    }
  }
}

function syncVis(agents) {
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const v = vis.get(a.id);
    if (v) {
      v.fromX = v.x;
      v.fromY = v.y;
      v.toX = a.x;
      v.toY = a.y;
      v.t0 = performance.now();
      v.keep = 1;
    } else {
      vis.set(a.id, { x: a.x, y: a.y, fromX: a.x, fromY: a.y, toX: a.x, toY: a.y, t0: performance.now(), keep: 1 });
    }
  }
  vis.forEach((v, id) => {
    if (v.keep) v.keep = 0;
    else vis.delete(id);
  });
}

function stepVis(v) {
  const u = Math.min(1, (this - v.t0) / 250);
  v.x = v.fromX + (v.toX - v.fromX) * u;
  v.y = v.fromY + (v.toY - v.fromY) * u;
}

function visPos(id, fallbackX, fallbackY, out) {
  const v = vis.get(id);
  if (v) {
    out.x = v.x;
    out.y = v.y;
  } else {
    out.x = fallbackX;
    out.y = fallbackY;
  }
  return out;
}

const _hit = { x: 0, y: 0 };
const _drawPos = { x: 0, y: 0 };

function hitAgentAtWorld(wx, wy) {
  if (!snap) return null;
  const list = snap.agents;
  let best = null;
  let bestD = 0.9;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    visPos(a.id, a.x, a.y, _hit);
    const d = Math.hypot(_hit.x - wx, _hit.y - wy);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

function hitAgentAt(tx, ty) {
  return hitAgentAtWorld(tx + 0.5, ty + 0.5);
}

function centerOnFirstSnap() {
  if (didCenter) return;
  if (!canvas.width || !canvas.height) return;
  const agent = snap?.agents?.[0];
  let cx = 24.5, cy = 21.5;
  if (agent) {
    cx = (agent.x + 26.5) / 2;
    cy = (agent.y + 22.5) / 2;
  }
  cam.x = cx * TILE - canvas.width / (2 * cam.z);
  cam.y = cy * TILE - canvas.height / (2 * cam.z);
  didCenter = true;
}

async function pollOnce() {
  if (polling) {
    pollQueued = true;
    return;
  }
  polling = true;
  try {
    const res = await fetch("/api/world/kale-1");
    if (res.ok) applyWorld(await res.json());
  } catch {
  } finally {
    polling = false;
    if (pollQueued) {
      pollQueued = false;
      pollOnce();
    }
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    ws = new WebSocket(`${proto}//${location.host}/agents/World/kale-1`);
  } catch {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connect, 3000);
    return;
  }
  ws.onopen = () => {};
  ws.onclose = () => {
    if (!wsToastShown) {
      wsToastShown = true;
      if (!snap) toast("world napped. reconnecting\u2026");
    }
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (!data || typeof data !== "object") return;
    if (data.type === "cf_agent_state") return;
    if (data.type === "map") applyWorld({ map: data });
    if (data.type === "snap") applyWorld({ snap: data });
  };
}
toast("loading kale-1\u2026");
connect();
pollOnce();
setInterval(pollOnce, 250);

function send(obj, opts) {
  fetch("/api/world/kale-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  })
    .then((res) => res.json())
    .then(async (data) => {
      if (data && data.msg && !opts?.quiet) toast(data.msg);
      await pollOnce();
      if (obj.type === "hire") selectHired(data);
    })
    .catch(() => {
      if (!opts?.quiet) toast("command failed");
    });
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  toastTimer = 240;
}

function tileKey(x, y) {
  return x + "," + y;
}

function localDes(x, y) {
  if (pendingDes.has(tileKey(x, y))) return pendingDes.get(tileKey(x, y));
  return plotAt(x, y)?.designation ?? null;
}

function markTile(x, y, kind) {
  const des = !kind || kind === "clear" ? null : kind;
  pendingDes.set(tileKey(x, y), des);
  if (snap) {
    let p = snap.plots.find((q) => q.x === x && q.y === y);
    if (p) p.designation = des;
    else if (des) {
      snap.plots.push({
        x, y, state: "empty", growth: 0, yield: 1, wilt: 0, tended: 0,
        designation: des, claimedBy: null, groundKale: 0,
      });
    }
  }
}

function reconcilePending() {
  if (!snap || !pendingDes.size) return;
  for (const [k, des] of [...pendingDes]) {
    const [x, y] = k.split(",").map(Number);
    const p = snap.plots.find((q) => q.x === x && q.y === y);
    if (p && p.designation === des) pendingDes.delete(k);
    else if (p) p.designation = des;
    else if (des) {
      snap.plots.push({
        x, y, state: "empty", growth: 0, yield: 1, wilt: 0, tended: 0,
        designation: des, claimedBy: null, groundKale: 0,
      });
    } else {
      pendingDes.delete(k);
    }
  }
}

function selectHired(data) {
  const id = data?.extra?.id;
  const hit = id && snap ? snap.agents.find((x) => x.id === id) : null;
  if (hit) {
    selectAgent(hit);
    return;
  }
  if (!snap?.agents?.length) return;
  let newest = snap.agents[0];
  for (const x of snap.agents) {
    const n = Number(String(x.id).replace(/\D/g, "")) || 0;
    const b = Number(String(newest.id).replace(/\D/g, "")) || 0;
    if (n >= b) newest = x;
  }
  selectAgent(newest);
}

function paintHud() {
  if (!snap) return;
  const h = snap.hud;
  hudEl.kale.textContent = h.kale.toFixed(1);
  hudEl.yield.textContent = (h.yieldPerMin >= 0 ? "+" : "") + h.yieldPerMin.toFixed(1);
  hudEl.spend.textContent = h.spendPerMin.toFixed(2);
  hudEl.net.textContent = (h.netPerMin >= 0 ? "+" : "") + h.netPerMin.toFixed(2);
  hudEl.statNet.style.borderColor = h.netPerMin >= 0 ? "#7cfc00" : "#e85d04";
  hudEl.agents.textContent = String(h.agents);
  hudEl.idle.textContent = String(h.idle);
  hudEl.btnIdle.classList.toggle("on", h.idle > 0);
  const unused = h.unused ?? 0;
  hudEl.unused.textContent = unused.toFixed(1);
  if (hudEl.staff) hudEl.staff.textContent = staffLabel(h.staff);
  const constraint = ({ rot: "ripe", haul: "piles", plant: "empty", ok: "ok" }[h.bottleneck] || h.bottleneck || "ok");
  hudEl.line.textContent = constraint;
  hudEl.statLine.classList.remove("rot", "haul", "plant", "ok", "ripe", "piles", "empty");
  hudEl.statLine.classList.add(constraint);
  const bits = [];
  if (h.ripe) bits.push(`${h.ripe} ripe`);
  if (h.wilted) bits.push(`${h.wilted} wilted`);
  if (h.ground) bits.push(`${h.ground} piles`);
  if (unused) bits.push(`unused ${unused.toFixed(1)}`);
  hudEl.alerts.textContent = bits.join(" \u00b7 ");
  document.querySelectorAll("#speeds button").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.speed) === snap.speed);
  });
  if (hudEl.thought) hudEl.thought.textContent = snap.foreman?.thought || "barn brain quiet.";
  if (hudEl.farmfile && document.activeElement !== hudEl.farmfile) hudEl.farmfile.value = snap.rootPrompt || "";
  paintDesires();
}

function paintDesires() {
  const list = document.getElementById("desires");
  if (!list) return;
  const items = snap.desires || [];
  list.innerHTML = items.length ? items.map((d) => {
    const cancel = d.status !== "done"
      ? `<button onclick='send({type:"cancelDesire",id:${d.id}})'>cancel</button>`
      : "";
    const note = d.note ? `<div class="note">${escapeHtml(d.note)}</div>` : "";
    return `<li><span class="st ${d.status}">${d.status}</span><span class="dtext">${escapeHtml(d.text)}</span>${cancel}${note}</li>`;
  }).join("") : `<li class="muted">no desires. the barn invents its own.</li>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function staffLabel(s) {
  if (!s) return "\u2014";
  return `${s.planter || 0}P ${s.worker || 0}W ${s.harvester || 0}H ${s.hauler || 0}Ha ${s.builder || 0}B`;
}

function queueDesire() {
  const el = document.getElementById("desire-text");
  const text = (el.value || "").trim();
  if (!text) return;
  send({ type: "desire", text });
  el.value = "";
}

document.querySelectorAll("#tools button").forEach((b) => {
  if (b.dataset.tool === tool) b.classList.add("on");
  b.onclick = () => {
    if (b.dataset.tool === tool && paintOn) {
      paintOn = false;
      if (paintToggle) paintToggle.checked = false;
      paintLabel?.classList.remove("on");
      toast("paint off. click inspects.");
      return;
    }
    tool = b.dataset.tool;
    document.querySelectorAll("#tools button").forEach((x) => x.classList.toggle("on", x === b));
    toast(paintOn ? `tool: ${tool}. paint to mark tiles.` : `tool: ${tool}. turn Paint on to mark tiles.`);
  };
});
const paintToggle = document.getElementById("paint-toggle");
const paintLabel = document.getElementById("paint-label");
if (paintToggle) {
  paintToggle.checked = false;
  paintToggle.onchange = () => {
    paintOn = !!paintToggle.checked;
    paintLabel?.classList.toggle("on", paintOn);
    toast(paintOn ? "paint on. click or drag to mark tiles." : "paint off. click inspects.");
  };
}
document.querySelectorAll("#speeds button").forEach((b) => {
  b.onclick = () => {
    send({ type: "speed", speed: Number(b.dataset.speed) });
    document.querySelectorAll("#speeds button").forEach((x) => x.classList.toggle("on", x === b));
  };
});
const hireBox = document.getElementById("hire");
JOBS.forEach((j) => {
  const b = document.createElement("button");
  b.innerHTML = `<span>${j.label}</span><span>${j.hire} K \u00b7 ${j.burn}/min</span>`;
  b.onclick = () => send({ type: "hire", job: j.id });
  hireBox.appendChild(b);
});
document.getElementById("btn-idle").onclick = cycleIdle;
document.getElementById("btn-save").onclick = () => {
  if (selected?.kind !== "agent") return;
  send({ type: "saveJob", id: selected.id, markdown: document.getElementById("jobfile").value });
};
document.getElementById("btn-save-farm").onclick = () => {
  send({ type: "saveFarm", markdown: document.getElementById("farmfile").value });
};
document.getElementById("btn-desire").onclick = queueDesire;
document.getElementById("desire-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    queueDesire();
  }
});

window.addEventListener("keydown", (e) => {
  keys.add(e.key.toLowerCase());
  if (["input", "textarea"].includes(document.activeElement.tagName.toLowerCase())) return;
  if (e.key === "i" || e.key === "I") cycleIdle();
  if (e.key === "1") send({ type: "speed", speed: 1 });
  if (e.key === "3") send({ type: "speed", speed: 3 });
  if (e.key === "0") send({ type: "speed", speed: 10 });
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("mousedown", (e) => {
  if (e.button === 1 || e.button === 2) {
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    return;
  }
  if (e.button !== 0) return;
  const w = screenToWorld(e);
  if (!w) return;
  lastTile = { x: w.tx, y: w.ty };
  const hit = hitAgentAtWorld(w.wx, w.wy);
  if (hit) { selectAgent(hit); return; }
  if (selected?.kind === "agent" && e.ctrlKey) {
    send({ type: "queue", agentId: selected.id, kind: tool === "clear" ? "plant" : tool, x: w.tx, y: w.ty });
    return;
  }
  const painting = paintOn || e.shiftKey;
  if (painting && !inBarn(w.tx, w.ty)) {
    markTile(w.tx, w.ty, tool);
    send({ type: "designate", x: w.tx, y: w.ty, kind: tool });
    paintDrag = { lastX: w.tx, lastY: w.ty };
  }
  inspectAt({ x: w.tx, y: w.ty });
});
window.addEventListener("mousemove", (e) => {
  if (drag) {
    cam.x = drag.cx - (e.clientX - drag.x) / cam.z;
    cam.y = drag.cy - (e.clientY - drag.y) / cam.z;
    return;
  }
  if (!paintDrag) return;
  const w = screenToWorld(e);
  if (!w) return;
  if (hitAgentAtWorld(w.wx, w.wy)) return;
  if (inBarn(w.tx, w.ty)) return;
  if (w.tx === paintDrag.lastX && w.ty === paintDrag.lastY) return;
  paintDrag.lastX = w.tx;
  paintDrag.lastY = w.ty;
  lastTile = { x: w.tx, y: w.ty };
  markTile(w.tx, w.ty, tool);
  send({ type: "designate", x: w.tx, y: w.ty, kind: tool }, { quiet: true });
  selected = { kind: "tile", x: w.tx, y: w.ty };
  refreshInspect();
});
window.addEventListener("mouseup", () => {
  drag = null;
  paintDrag = null;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const old = cam.z;
  cam.z = Math.min(2.4, Math.max(0.55, cam.z * (e.deltaY > 0 ? 0.92 : 1.08)));
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const wx = cam.x + mx / old;
  const wy = cam.y + my / old;
  cam.x = wx - mx / cam.z;
  cam.y = wy - my / cam.z;
}, { passive: false });

mini.onclick = (e) => {
  const r = mini.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * MAP_W * TILE;
  const y = ((e.clientY - r.top) / r.height) * MAP_H * TILE;
  cam.x = x - canvas.width / (2 * cam.z);
  cam.y = y - canvas.height / (2 * cam.z);
};

function screenToWorld(e) {
  const r = canvas.getBoundingClientRect();
  const wx = (cam.x + (e.clientX - r.left) / cam.z) / TILE;
  const wy = (cam.y + (e.clientY - r.top) / cam.z) / TILE;
  const tx = Math.floor(wx);
  const ty = Math.floor(wy);
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return null;
  return { wx, wy, tx, ty };
}

function screenToTile(e) {
  const w = screenToWorld(e);
  return w ? { x: w.tx, y: w.ty } : null;
}

function inBarn(x, y) {
  const barn = map.barn;
  return x >= barn.x && x < barn.x + barn.w && y >= barn.y && y < barn.y + barn.h;
}

function inspectAt(t) {
  if (inBarn(t.x, t.y)) {
    selected = { kind: "barn" };
    renderInspectBarn();
    document.getElementById("editor").classList.add("hidden");
    return;
  }
  selected = { kind: "tile", x: t.x, y: t.y };
  renderInspectTile(t);
  document.getElementById("editor").classList.add("hidden");
}

function resetInspect() {
  inspectSig = "";
  const el = document.getElementById("inspect");
  el.innerHTML = `<p class="section">Inspect</p><p class="muted">Click a tile, a pail, or the barn.</p>`;
}

function refreshInspect() {
  if (!selected) return;
  if (selected.kind === "agent") {
    const a = snap?.agents.find((x) => x.id === selected.id);
    if (!a) {
      selected = null;
      resetInspect();
      document.getElementById("editor").classList.add("hidden");
      return;
    }
    renderInspectAgent(a);
  } else if (selected.kind === "tile") {
    renderInspectTile(selected);
  } else if (selected.kind === "barn") {
    renderInspectBarn();
  }
}

function selectAgent(a) {
  selected = { kind: "agent", id: a.id };
  renderInspectAgent(a);
  const ed = document.getElementById("editor");
  ed.classList.remove("hidden");
  document.getElementById("editor-name").textContent = a.name;
  document.getElementById("jobfile").value = a.jobFile;
}

function cycleIdle() {
  if (!snap || !snap.idleIds.length) { toast("nobody is idle. rare. enjoy it."); return; }
  idleCycle = idleCycle % snap.idleIds.length;
  const id = snap.idleIds[idleCycle++];
  const a = snap.agents.find((x) => x.id === id);
  if (!a) return;
  visPos(a.id, a.x, a.y, _hit);
  cam.x = _hit.x * TILE - canvas.width / (2 * cam.z);
  cam.y = _hit.y * TILE - canvas.height / (2 * cam.z);
  selectAgent(a);
  toast(`${a.name} is idle. edit the file or queue an order.`);
}

function plotAt(x, y) {
  return snap?.plots.find((p) => p.x === x && p.y === y);
}

function renderInspectTile(t) {
  const el = document.getElementById("inspect");
  if (inspectSig !== "tile") {
    inspectSig = "tile";
    el.innerHTML = `<h3 id="ins-h"></h3>
      <div id="ins-terr"></div>
      <div id="ins-plot"></div>
      <div id="ins-stats"></div>
      <div id="ins-des"></div>
      <div id="ins-ground"></div>
      <p class="muted" id="ins-note"></p>
      <div class="queue" id="ins-q">
        <button data-dk="plant">plant</button>
        <button data-dk="tend">tend</button>
        <button data-dk="harvest">harvest</button>
        <button data-dk="haul">haul</button>
        <button data-dk="build">build</button>
      </div>`;
    el.querySelectorAll("[data-dk]").forEach((b) => {
      b.onclick = () => {
        if (selected?.kind !== "tile") return;
        markTile(selected.x, selected.y, b.dataset.dk);
        send({ type: "designate", x: selected.x, y: selected.y, kind: b.dataset.dk });
        refreshInspect();
      };
    });
  }
  const p = plotAt(t.x, t.y);
  const desNow = localDes(t.x, t.y);
  const terr = ["grass", "dirt", "barn", "well", "path"][map.terrain[t.y * MAP_W + t.x]] || "?";
  document.getElementById("ins-h").textContent = `Tile ${t.x},${t.y}`;
  document.getElementById("ins-terr").textContent = `terrain: ${terr}`;
  document.getElementById("ins-plot").textContent = `plot: ${p ? p.state : "none"}`;
  const stats = document.getElementById("ins-stats");
  const des = document.getElementById("ins-des");
  const ground = document.getElementById("ins-ground");
  const note = document.getElementById("ins-note");
  if (p) {
    stats.textContent = `growth ${(p.growth * 100).toFixed(0)}% \u00b7 yield ${p.yield.toFixed(2)} \u00b7 wilt ${p.wilt.toFixed(1)}s`;
    des.textContent = `designation: ${desNow || "\u2014"} ${p.claimedBy ? "claimed" : "open"}`;
    ground.textContent = `ground kale: ${p.groundKale.toFixed(2)}`;
    note.textContent = "";
  } else if (desNow) {
    stats.textContent = "";
    des.textContent = `designation: ${desNow} open`;
    ground.textContent = "";
    note.textContent = desNow === "build" ? "Marked for build. A builder will turn this grass into a plot." : "Marked. waiting on the snap.";
  } else {
    stats.textContent = "";
    des.textContent = "";
    ground.textContent = "";
    note.textContent = "Grass. Build to turn it into a plot.";
  }
}

function renderInspectBarn() {
  const el = document.getElementById("inspect");
  if (inspectSig !== "barn") {
    inspectSig = "barn";
    el.innerHTML = `<h3>Barn</h3>
      <p>The barn is the wallet. There is no wallet.</p>
      <div id="ins-stock"></div>
      <div id="ins-kale"></div>
      <p class="muted">Haulers drop here. Hire is paid from liquid KALE.</p>
      <p class="muted" id="ins-foreman"></p>
      <p class="muted" id="ins-last"></p>`;
  }
  document.getElementById("ins-stock").textContent = `stockpile: ${(snap?.barn?.stock ?? 0).toFixed(1)} KALE hauled`;
  document.getElementById("ins-kale").textContent = `liquid KALE: ${(snap?.hud.kale ?? 0).toFixed(1)}`;
  document.getElementById("ins-foreman").textContent = `Foreman: ${snap?.foreman?.thought || "\u2014"}`;
  document.getElementById("ins-last").textContent = `last act: ${snap?.foreman?.lastAct || "\u2014"}`;
}

function renderInspectAgent(a) {
  const el = document.getElementById("inspect");
  const rank = pailRank(a);
  const sig = `agent|${a.id}|${rank}|${a.job}`;
  if (inspectSig !== sig) {
    inspectSig = sig;
    const nextCost = 10 * rank;
    const promo = rank >= 5
      ? `<p class="muted">Pail V. cannot promote further.</p>`
      : `<button id="ins-promo" style="margin-top:8px;width:100%">Promote to ${"Pail " + ROMAN[rank]} (${nextCost} KALE)</button>`;
    el.innerHTML = `<h3><span id="ins-name"></span> <span id="ins-dot">\u25cf</span></h3>
      <div id="ins-meta"></div>
      <div>action: <b id="ins-action"></b> \u2014 <span id="ins-detail"></span></div>
      <div>carrying: <span id="ins-carry"></span></div>
      <div class="muted" id="ins-thought"></div>
      ${promo}
      <p class="muted" id="ins-qhint"></p>
      <div class="queue" id="ins-q">
        ${["plant","tend","harvest","haul","build"].map((k) => `<button data-qkind="${k}">${k}</button>`).join("")}
      </div>
      <button class="danger" id="ins-fire" style="margin-top:8px;width:100%"></button>`;
    const promoBtn = document.getElementById("ins-promo");
    if (promoBtn) promoBtn.onclick = () => send({ type: "promote", id: a.id });
    el.querySelectorAll("[data-qkind]").forEach((b) => {
      b.onclick = () => send({ type: "queue", agentId: a.id, kind: b.dataset.qkind, x: lastTile.x, y: lastTile.y });
    });
    document.getElementById("ins-fire").onclick = () => send({ type: "fire", id: a.id });
  }
  document.getElementById("ins-name").textContent = a.name;
  const dot = document.getElementById("ins-dot");
  dot.style.color = BAND[a.job] || "#fff";
  document.getElementById("ins-meta").textContent = `${a.job} \u00b7 ${pailTitle(a)} \u00b7 burn ${a.burn}/min`;
  document.getElementById("ins-action").textContent = a.action;
  document.getElementById("ins-detail").textContent = a.detail;
  document.getElementById("ins-carry").textContent = a.carrying.toFixed(2);
  document.getElementById("ins-thought").textContent = a.thinking ? "thinking\u2026" : a.thought;
  document.getElementById("ins-qhint").textContent = `Queue an order on last tile ${lastTile.x},${lastTile.y} (or ctrl-click a tile).`;
  document.getElementById("ins-fire").textContent = `Fire ${a.name}`;
  document.getElementById("editor").classList.remove("hidden");
  document.getElementById("editor-name").textContent = a.name;
  const ta = document.getElementById("jobfile");
  if (document.activeElement !== ta) ta.value = a.jobFile;
}

window.send = send;

function worldX(x) { return (x * TILE - cam.x) * cam.z; }
function worldY(y) { return (y * TILE - cam.y) * cam.z; }

let lastDraw = 0;
let miniFrame = 0;
function draw(now) {
  requestAnimationFrame(draw);
  if (document.hidden) return;
  const t = typeof now === "number" ? now : performance.now();
  const dt = lastDraw ? Math.min(0.05, (t - lastDraw) / 1000) : 1 / 60;
  lastDraw = t;
  let mx = 0, my = 0;
  if (keys.has("a") || keys.has("arrowleft")) mx -= 1;
  if (keys.has("d") || keys.has("arrowright")) mx += 1;
  if (keys.has("w") || keys.has("arrowup")) my -= 1;
  if (keys.has("s") || keys.has("arrowdown")) my += 1;
  cam.x += mx * 420 * dt / cam.z;
  cam.y += my * 420 * dt / cam.z;
  vis.forEach(stepVis, t);
  if (toastTimer > 0) toastTimer--;
  if (awaitingSnap) {
    hudEl.toast.textContent = "loading kale-1\u2026";
    hudEl.toast.style.opacity = "1";
  } else {
    hudEl.toast.style.opacity = toastTimer > 0 ? "1" : "0";
  }
  renderFarm();
  if ((miniFrame++ & 3) === 0) renderMini();
}
requestAnimationFrame(draw);

function terrainAt(x, y) {
  return map.terrain[y * MAP_W + x] || 0;
}

function renderFarm() {
  ctx.fillStyle = "#1e2e18";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const z = cam.z;
  const x0 = Math.max(0, Math.floor(cam.x / TILE) - 1);
  const y0 = Math.max(0, Math.floor(cam.y / TILE) - 1);
  const x1 = Math.min(MAP_W, Math.ceil((cam.x + canvas.width / z) / TILE) + 1);
  const y1 = Math.min(MAP_H, Math.ceil((cam.y + canvas.height / z) / TILE) + 1);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const px = worldX(x);
      const py = worldY(y);
      const s = TILE * z;
      const t = terrainAt(x, y);
      if (t === 0) {
        ctx.fillStyle = (x + y) % 2 ? "#3d6b2f" : "#355f28";
        ctx.fillRect(px, py, s, s);
      } else if (t === 4) {
        ctx.fillStyle = "#c4a574";
        ctx.fillRect(px, py, s, s);
        ctx.strokeStyle = "#a88858";
        ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
      } else if (t === 1) {
        ctx.fillStyle = "#6b4423";
        ctx.fillRect(px, py, s, s);
      } else if (t === 2) {
        ctx.fillStyle = "#8b5a2b";
        ctx.fillRect(px, py, s, s);
      } else if (t === 3) {
        ctx.fillStyle = "#6d7c7c";
        ctx.fillRect(px, py, s, s);
      }
    }
  }

  if (snap) {
    for (const p of snap.plots) {
      const px = worldX(p.x);
      const py = worldY(p.y);
      const s = TILE * z;
      if (p.state === "tilled") {
        ctx.fillStyle = "#5a3618";
        ctx.fillRect(px, py, s, s);
        ctx.strokeStyle = "#3f240f";
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(px, py + (s * i) / 4);
          ctx.lineTo(px + s, py + (s * i) / 4);
          ctx.stroke();
        }
      }
      drawKale(p, px, py, s);
      if (p.groundKale > 0) {
        ctx.fillStyle = "#2f6b1e";
        ctx.beginPath();
        ctx.ellipse(px + s * 0.3, py + s * 0.78, s * 0.18, s * 0.1, 0, 0, 7);
        ctx.ellipse(px + s * 0.55, py + s * 0.8, s * 0.16, s * 0.09, 0, 0, 7);
        ctx.fill();
      }
      if (p.designation) {
        const rgb = DES_COL[p.designation] || "255,229,102";
        ctx.fillStyle = `rgba(${rgb},0.3)`;
        ctx.fillRect(px, py, s, s);
        ctx.strokeStyle = "#ffe566";
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, s - 4, s - 4);
        ctx.lineWidth = 1;
        ctx.fillStyle = "#ffe566";
        ctx.font = `bold ${Math.max(11, 13 * z)}px IBM Plex Mono`;
        ctx.fillText(p.designation[0].toUpperCase(), px + 5, py + 15 * z);
      }
    }
  }

  drawBarn();
  drawWell();

  if (snap) {
    for (const a of snap.agents) drawPail(a);
  }

  if (selected?.kind === "tile") {
    const px = worldX(selected.x), py = worldY(selected.y), s = TILE * z;
    ctx.strokeStyle = "#c8ff7a";
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, s, s);
  }
}

function drawKale(p, px, py, s) {
  if (p.state === "empty" || p.state === "tilled") return;
  const g = p.state === "ripe" ? 1 : p.state === "wilted" ? 0.7 : Math.max(0.15, p.growth);
  const big = p.state === "ripe" ? 1.35 : 1;
  const col = p.state === "wilted" ? "#6b6b32" : p.state === "ripe" ? "#5fe02a" : "#3fae22";
  const dark = p.state === "wilted" ? "#4a4a20" : "#2c7a18";
  const cx = px + s / 2;
  const cy = py + s * (0.62 - 0.08 * g * big);
  const r = s * (0.12 + 0.28 * g) * big;
  ctx.fillStyle = "#2a1a0c";
  ctx.fillRect(cx - 1.5, cy, 3, s * 0.28);
  for (let i = 0; i < 5; i++) {
    const ang = -Math.PI / 2 + i * 0.9;
    ctx.fillStyle = i % 2 ? col : dark;
    ctx.beginPath();
    ctx.ellipse(cx + Math.cos(ang) * r * 0.45, cy + Math.sin(ang) * r * 0.25, r * 0.55, r * 0.28, ang, 0, 7);
    ctx.fill();
  }
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.ellipse(cx, cy - r * 0.1, r * 0.42, r * 0.32, 0, 0, 7);
  ctx.fill();
}

function drawBarn() {
  const b = map.barn;
  const px = worldX(b.x), py = worldY(b.y);
  const w = b.w * TILE * cam.z, h = b.h * TILE * cam.z;
  ctx.fillStyle = "#7a4a24";
  ctx.fillRect(px, py + h * 0.25, w, h * 0.75);
  ctx.fillStyle = "#a33";
  ctx.beginPath();
  ctx.moveTo(px - 4, py + h * 0.28);
  ctx.lineTo(px + w / 2, py - 6);
  ctx.lineTo(px + w + 4, py + h * 0.28);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#3a2414";
  ctx.fillRect(px + w * 0.38, py + h * 0.55, w * 0.24, h * 0.45);
  ctx.fillStyle = "#c8ff7a";
  ctx.font = `${Math.max(10, 11 * cam.z)}px Lilita One, sans-serif`;
  ctx.fillText("BARN", px + 8, py + h * 0.48);
  if (snap) {
    ctx.fillStyle = "#f4ffd4";
    ctx.font = `${Math.max(9, 10 * cam.z)}px IBM Plex Mono`;
    ctx.fillText(snap.barn.stock.toFixed(0) + "K", px + 8, py + h * 0.42);
  }
}

function drawWell() {
  const w = map.well;
  const px = worldX(w.x), py = worldY(w.y), s = TILE * cam.z;
  ctx.fillStyle = "#4d5c5c";
  ctx.beginPath();
  ctx.ellipse(px + s / 2, py + s * 0.62, s * 0.38, s * 0.18, 0, 0, 7);
  ctx.fill();
  ctx.fillStyle = "#1b3344";
  ctx.beginPath();
  ctx.ellipse(px + s / 2, py + s * 0.6, s * 0.22, s * 0.1, 0, 0, 7);
  ctx.fill();
  ctx.strokeStyle = "#c4a574";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px + s * 0.22, py + s * 0.55);
  ctx.lineTo(px + s * 0.22, py + s * 0.18);
  ctx.lineTo(px + s * 0.78, py + s * 0.18);
  ctx.lineTo(px + s * 0.78, py + s * 0.55);
  ctx.stroke();
}

function drawPail(a) {
  const z = cam.z;
  visPos(a.id, a.x, a.y, _drawPos);
  const px = (_drawPos.x * TILE - cam.x) * z;
  const py = (_drawPos.y * TILE - cam.y) * z;
  const s = TILE * z;
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath();
  ctx.ellipse(px, py + s * 0.18, s * 0.22, s * 0.1, 0, 0, 7);
  ctx.fill();
  ctx.fillStyle = "#cfd3d6";
  ctx.beginPath();
  ctx.moveTo(px - s * 0.16, py - s * 0.02);
  ctx.lineTo(px - s * 0.2, py + s * 0.22);
  ctx.quadraticCurveTo(px, py + s * 0.3, px + s * 0.2, py + s * 0.22);
  ctx.lineTo(px + s * 0.16, py - s * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#6d747a";
  ctx.stroke();
  ctx.strokeStyle = BAND[a.job] || "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px - s * 0.17, py + s * 0.08);
  ctx.lineTo(px + s * 0.17, py + s * 0.08);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#889";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(px, py - s * 0.02, s * 0.14, Math.PI, 0);
  ctx.stroke();
  ctx.lineWidth = 1;
  if (a.carrying > 0) {
    ctx.fillStyle = "#3fae22";
    ctx.beginPath();
    ctx.ellipse(px, py + s * 0.05, s * 0.12, s * 0.08, 0, 0, 7);
    ctx.fill();
  }
  ctx.fillStyle = "#f4ffd4";
  ctx.font = `${Math.max(9, 10 * z)}px IBM Plex Mono`;
  ctx.textAlign = "center";
  ctx.fillText(a.name, px, py - s * 0.28);
  ctx.textAlign = "left";
  if (a.idle) {
    ctx.fillStyle = "#ffe566";
    ctx.beginPath();
    ctx.arc(px + s * 0.18, py - s * 0.18, 5 * z, 0, 7);
    ctx.fill();
  }
  if (a.thinking) {
    ctx.fillStyle = "#4cc9f0";
    ctx.fillText("\u2026", px + 6, py - s * 0.4);
  }
  if (selected?.kind === "agent" && selected.id === a.id) {
    ctx.strokeStyle = "#c8ff7a";
    ctx.strokeRect(px - s * 0.28, py - s * 0.45, s * 0.56, s * 0.8);
  }
}

function renderMini() {
  const c = mctx;
  const w = mini.width, h = mini.height;
  const sx = w / MAP_W, sy = h / MAP_H;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = terrainAt(x, y);
      c.fillStyle = t === 1 ? "#6b4423" : t === 2 ? "#a33" : t === 3 ? "#68a" : t === 4 ? "#c4a574" : "#3d6b2f";
      c.fillRect(x * sx, y * sy, sx, sy);
    }
  }
  if (snap) {
    for (const p of snap.plots) {
      if (p.state === "ripe") c.fillStyle = "#7cfc00";
      else if (p.state === "growing" || p.state === "planted") c.fillStyle = "#2f8a1e";
      else if (p.state === "wilted") c.fillStyle = "#666";
      else continue;
      c.fillRect(p.x * sx, p.y * sy, sx, sy);
    }
    c.fillStyle = "#fff";
    for (const a of snap.agents) {
      visPos(a.id, a.x, a.y, _drawPos);
      c.fillRect(_drawPos.x * sx - 1, _drawPos.y * sy - 1, 3, 3);
    }
  }
  c.strokeStyle = "#c8ff7a";
  const vx = (cam.x / TILE) * sx;
  const vy = (cam.y / TILE) * sy;
  const vw = (canvas.width / cam.z / TILE) * sx;
  const vh = (canvas.height / cam.z / TILE) * sy;
  c.strokeRect(vx, vy, vw, vh);
}
