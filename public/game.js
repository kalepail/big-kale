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
let drag = null;
let selected = null; // {kind:'agent'|'tile'|'barn', ...}
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
    paintHud();
    if (first || !didCenter) centerOnFirstSnap();
    if (first) {
      const farmfile = document.getElementById("farmfile");
      if (farmfile && document.activeElement !== farmfile) farmfile.value = next.rootPrompt || "";
    }
    if (selected?.kind === "agent") {
      const a = next.agents.find((x) => x.id === selected.id);
      if (a) renderInspectAgent(a);
    } else if (selected?.kind === "barn") {
      renderInspectBarn();
    }
  }
  if (!greeted && snap) {
    greeted = true;
    toast("connected to kale-1. one planter. forty kale. write a file.");
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

function hitAgentAt(tx, ty) {
  if (!snap) return null;
  const cx = tx + 0.5, cy = ty + 0.5;
  const list = snap.agents;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    visPos(a.id, a.x, a.y, _hit);
    if (Math.hypot(_hit.x - cx, _hit.y - cy) < 0.65) return a;
  }
  return null;
}

function centerOnFirstSnap() {
  if (didCenter) return;
  if (!canvas.width || !canvas.height) return;
  const agent = snap?.agents?.[0];
  // Barn ~22.5,19.5; home plots ~26.5,23.5; planter ~20.2,21.4
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
    // keep polling; HTTP is the live view
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
      toast("world napped. reconnecting…");
      wsToastShown = true;
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
connect();
pollOnce();
setInterval(pollOnce, 250);

function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  fetch("/api/world/kale-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.msg) toast(data.msg);
      pollOnce();
    })
    .catch(() => toast("command failed"));
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  toastTimer = 240;
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
  const line = h.bottleneck || "ok";
  hudEl.line.textContent = line;
  hudEl.statLine.classList.remove("rot", "haul", "plant", "ok");
  hudEl.statLine.classList.add(line);
  const bits = [];
  if (line && line !== "ok") bits.push(line);
  if (h.ripe) bits.push(`${h.ripe} ripe`);
  if (h.wilted) bits.push(`${h.wilted} wilted`);
  if (h.ground) bits.push(`${h.ground} piles`);
  if (unused) bits.push(`unused ${unused.toFixed(1)}`);
  hudEl.alerts.textContent = bits.join(" · ");
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

function queueDesire() {
  const el = document.getElementById("desire-text");
  const text = (el.value || "").trim();
  if (!text) return;
  send({ type: "desire", text });
  el.value = "";
}

// tools
document.querySelectorAll("#tools button").forEach((b) => {
  if (b.dataset.tool === tool) b.classList.add("on");
  b.onclick = () => {
    tool = b.dataset.tool;
    document.querySelectorAll("#tools button").forEach((x) => x.classList.toggle("on", x === b));
    toast(`tool: ${tool}. click tiles. jobs live on the dirt.`);
  };
});
document.querySelectorAll("#speeds button").forEach((b) => {
  b.onclick = () => {
    send({ type: "speed", speed: Number(b.dataset.speed) });
    document.querySelectorAll("#speeds button").forEach((x) => x.classList.toggle("on", x === b));
  };
});
const hireBox = document.getElementById("hire");
JOBS.forEach((j) => {
  const b = document.createElement("button");
  b.innerHTML = `<span>${j.label}</span><span>${j.hire} K · ${j.burn}/min</span>`;
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
  if (e.button === 1 || e.button === 2 || e.shiftKey) {
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    return;
  }
  const t = screenToTile(e);
  if (!t) return;
  lastTile = t;
  if (snap) {
    const hit = hitAgentAt(t.x, t.y);
    if (hit && !e.ctrlKey) { selectAgent(hit); return; }
  }
  const barn = map.barn;
  if (t.x >= barn.x && t.x < barn.x + barn.w && t.y >= barn.y && t.y < barn.y + barn.h && !e.ctrlKey) {
    inspectAt(t, e);
    return;
  }
  if (e.altKey) {
    inspectAt(t, e);
    return;
  }
  if (selected?.kind === "agent" && e.ctrlKey) {
    send({ type: "queue", agentId: selected.id, kind: tool === "clear" ? "plant" : tool, x: t.x, y: t.y });
    return;
  }
  send({ type: "designate", x: t.x, y: t.y, kind: tool });
  inspectAt(t, e);
});
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  cam.x = drag.cx - (e.clientX - drag.x) / cam.z;
  cam.y = drag.cy - (e.clientY - drag.y) / cam.z;
});
window.addEventListener("mouseup", () => (drag = null));
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

function screenToTile(e) {
  const r = canvas.getBoundingClientRect();
  const x = cam.x + (e.clientX - r.left) / cam.z;
  const y = cam.y + (e.clientY - r.top) / cam.z;
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return null;
  return { x: tx, y: ty };
}

function inspectAt(t, e) {
  const barn = map.barn;
  if (snap) {
    const hit = hitAgentAt(t.x, t.y);
    if (hit) { selectAgent(hit); return; }
  }
  if (t.x >= barn.x && t.x < barn.x + barn.w && t.y >= barn.y && t.y < barn.y + barn.h) {
    selected = { kind: "barn" };
    renderInspectBarn();
    document.getElementById("editor").classList.add("hidden");
    return;
  }
  selected = { kind: "tile", x: t.x, y: t.y };
  renderInspectTile(t);
  document.getElementById("editor").classList.add("hidden");
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
  const p = plotAt(t.x, t.y);
  const terr = ["grass", "dirt", "barn", "well", "path"][map.terrain[t.y * MAP_W + t.x]] || "?";
  const el = document.getElementById("inspect");
  el.innerHTML = `<h3>Tile ${t.x},${t.y}</h3>
    <div>terrain: ${terr}</div>
    <div>plot: ${p ? p.state : "none"}</div>
    ${p ? `<div>growth ${(p.growth * 100).toFixed(0)}% · yield ${p.yield.toFixed(2)} · wilt ${p.wilt.toFixed(1)}s</div>
    <div>designation: ${p.designation || "—"} ${p.claimedBy ? "claimed" : "open"}</div>
    <div>ground kale: ${p.groundKale.toFixed(2)}</div>` : `<p class="muted">Grass. Build to turn it into a plot.</p>`}
    <div class="queue">
      <button onclick='send({type:"designate",x:${t.x},y:${t.y},kind:"plant"})'>plant</button>
      <button onclick='send({type:"designate",x:${t.x},y:${t.y},kind:"tend"})'>tend</button>
      <button onclick='send({type:"designate",x:${t.x},y:${t.y},kind:"harvest"})'>harvest</button>
      <button onclick='send({type:"designate",x:${t.x},y:${t.y},kind:"haul"})'>haul</button>
      <button onclick='send({type:"designate",x:${t.x},y:${t.y},kind:"build"})'>build</button>
    </div>`;
}

function renderInspectBarn() {
  const el = document.getElementById("inspect");
  const stock = snap?.barn?.stock ?? 0;
  el.innerHTML = `<h3>Barn</h3>
    <p>The barn is the wallet. There is no wallet.</p>
    <div>stockpile: ${stock.toFixed(1)} KALE hauled</div>
    <div>liquid KALE: ${(snap?.hud.kale ?? 0).toFixed(1)}</div>
    <p class="muted">Haulers drop here. Hire is paid from liquid KALE.</p>
    <p class="muted">Foreman: ${snap?.foreman?.thought || "—"}</p>
    <p class="muted">last act: ${snap?.foreman?.lastAct || "—"}</p>`;
}

function renderInspectAgent(a) {
  const el = document.getElementById("inspect");
  const rank = pailRank(a);
  const nextCost = 10 * rank;
  const promo = rank >= 5
    ? `<p class="muted">Pail V. cannot promote further.</p>`
    : `<button style="margin-top:8px;width:100%" onclick='send({type:"promote",id:"${a.id}"})'>Promote to ${"Pail " + ROMAN[rank]} (${nextCost} KALE)</button>`;
  el.innerHTML = `<h3>${a.name} <span style="color:${BAND[a.job]}">●</span></h3>
    <div>${a.job} · ${pailTitle(a)} · burn ${a.burn}/min</div>
    <div>action: <b>${a.action}</b> — ${a.detail}</div>
    <div>carrying: ${a.carrying.toFixed(2)}</div>
    <div class="muted">${a.thinking ? "thinking…" : a.thought}</div>
    ${promo}
    <p class="muted">Queue an order on last tile ${lastTile.x},${lastTile.y} (or ctrl-click a tile).</p>
    <div class="queue">
      ${["plant","tend","harvest","haul","build"].map((k) =>
        `<button onclick='send({type:"queue",agentId:"${a.id}",kind:"${k}",x:${lastTile.x},y:${lastTile.y}})'>${k}</button>`
      ).join("")}
    </div>
    <button class="danger" style="margin-top:8px;width:100%" onclick='send({type:"fire",id:"${a.id}"})'>Fire ${a.name}</button>`;
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
  hudEl.toast.style.opacity = toastTimer > 0 ? "1" : "0";
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

  // plots
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
        ctx.strokeStyle = "#ffe566";
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, s - 4, s - 4);
        ctx.lineWidth = 1;
        ctx.fillStyle = "#ffe566";
        ctx.font = `${Math.max(8, 9 * z)}px IBM Plex Mono`;
        ctx.fillText(p.designation[0].toUpperCase(), px + 4, py + 12 * z);
      }
    }
  }

  // barn & well details
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
  // shadow
  ctx.fillStyle = "rgba(0,0,0,.25)";
  ctx.beginPath();
  ctx.ellipse(px, py + s * 0.18, s * 0.22, s * 0.1, 0, 0, 7);
  ctx.fill();
  // body
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
  // job band
  ctx.strokeStyle = BAND[a.job] || "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px - s * 0.17, py + s * 0.08);
  ctx.lineTo(px + s * 0.17, py + s * 0.08);
  ctx.stroke();
  ctx.lineWidth = 1;
  // handle
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
    ctx.fillText("…", px + 6, py - s * 0.4);
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
