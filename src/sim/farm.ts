import {
  BARN,
  DEFAULT_JOB_FILES,
  DEFAULT_ROOT_PROMPT,
  HOME,
  JOB_STATS,
  MAP_H,
  MAP_W,
  PAIL_NAMES,
  START_KALE,
  TERRAIN,
  WELL,
  type JobKind,
} from "./constants";
import { jobPolicy } from "./policy";
import type { FarmAgent, FarmState, Plot } from "./types";

export function idx(x: number, y: number): number {
  return y * MAP_W + x;
}

export function createFarm(): FarmState {
  const terrain = new Array(MAP_W * MAP_H).fill(TERRAIN.grass);
  const plots: Plot[] = [];

  for (let y = BARN.y; y < BARN.y + BARN.h; y++) {
    for (let x = BARN.x; x < BARN.x + BARN.w; x++) {
      terrain[idx(x, y)] = TERRAIN.barn;
    }
  }
  terrain[idx(WELL.x, WELL.y)] = TERRAIN.well;

  for (let x = 20; x <= 28; x++) terrain[idx(x, 21)] = TERRAIN.path;
  for (let y = 21; y <= 25; y++) terrain[idx(24, y)] = TERRAIN.path;

  for (let y = HOME.y; y < HOME.y + HOME.h; y++) {
    for (let x = HOME.x; x < HOME.x + HOME.w; x++) {
      terrain[idx(x, y)] = TERRAIN.dirt;
      plots.push(emptyPlot(x, y));
    }
  }

  const planter = spawnAgent(0, "planter", 20.2, 21.4, 0);
  return {
    tick: 0,
    simTime: 0,
    speed: 1,
    kale: START_KALE,
    terrain,
    plots,
    agents: [planter],
    nextAgentId: 1,
    nextName: 1,
    yieldEvents: [],
    spendEvents: [{ t: 0, amt: 0 }],
    barnStock: 0,
    ripeCount: 0,
    wiltCount: 0,
    groundCount: 0,
    rootPrompt: DEFAULT_ROOT_PROMPT,
    desires: [],
    nextDesireId: 1,
    foreman: {
      thought: "barn brain online. human, sit down.",
      lastAct: "woke up",
      cooldown: 0,
      thinking: false,
      holdUntil: 0,
    },
  };
}


export function ensureFarmShape(farm: FarmState): FarmState {
  if (typeof farm.rootPrompt !== "string" || !farm.rootPrompt) {
    farm.rootPrompt = DEFAULT_ROOT_PROMPT;
  }
  if (!Array.isArray(farm.desires)) farm.desires = [];
  for (const d of farm.desires) {
    if (typeof d.id !== "number") d.id = 0;
    if (typeof d.text !== "string") d.text = "";
    if (typeof d.t !== "number") d.t = 0;
    if (d.status !== "queued" && d.status !== "doing" && d.status !== "done") d.status = "queued";
    if (typeof d.note !== "string") d.note = "";
  }
  if (typeof farm.nextDesireId !== "number" || !Number.isFinite(farm.nextDesireId)) {
    farm.nextDesireId = farm.desires.reduce((m, d) => Math.max(m, d.id), 0) + 1;
  }
  const f = farm.foreman as FarmState["foreman"] | undefined;
  if (!f || typeof f !== "object") {
    farm.foreman = {
      thought: "barn brain online. human, sit down.",
      lastAct: "woke up",
      cooldown: 0,
      thinking: false,
      holdUntil: 0,
    };
  } else {
    if (typeof f.thought !== "string") f.thought = "barn brain online.";
    if (typeof f.lastAct !== "string") f.lastAct = "";
    if (typeof f.cooldown !== "number" || !Number.isFinite(f.cooldown)) f.cooldown = 0;
    if (typeof f.thinking !== "boolean") f.thinking = false;
    if (typeof f.holdUntil !== "number" || !Number.isFinite(f.holdUntil)) f.holdUntil = 0;
  }
  for (const a of farm.agents) {
    if (typeof a.rank !== "number" || !Number.isFinite(a.rank) || a.rank < 1) a.rank = 1;
    if (a.rank > 5) a.rank = 5;
  }
  return farm;
}

export function emptyPlot(x: number, y: number): Plot {
  return {
    x,
    y,
    state: "empty",
    growth: 0,
    yield: 1,
    wilt: 0,
    tended: 0,
    designation: null,
    claimedBy: null,
    groundKale: 0,
  };
}

export function spawnAgent(
  idNum: number,
  job: JobKind,
  x: number,
  y: number,
  nameIndex: number,
): FarmAgent {
  const stats = JOB_STATS[job];
  return {
    id: `pail-${idNum}`,
    name: PAIL_NAMES[nameIndex % PAIL_NAMES.length],
    job,
    x,
    y,
    burn: stats.burn,
    jobFile: DEFAULT_JOB_FILES[job],
    policy: jobPolicy(job, DEFAULT_JOB_FILES[job]),
    action: { type: "idle" },
    forced: null,
    idleSince: 0,
    carrying: 0,
    thinking: false,
    thought: "waiting for a job. the soil is judging me.",
    rank: 1,
  };
}

export function plotAt(farm: FarmState, x: number, y: number): Plot | undefined {
  return farm.plots.find((p) => p.x === x && p.y === y);
}

export function pruneLedger(farm: FarmState): void {
  const cutoff = farm.simTime - 60;
  farm.yieldEvents = farm.yieldEvents.filter((e) => e.t >= cutoff);
  farm.spendEvents = farm.spendEvents.filter((e) => e.t >= cutoff);
}

export function sumWindow(events: { t: number; amt: number }[], now: number): number {
  const cutoff = now - 60;
  let s = 0;
  for (const e of events) if (e.t >= cutoff) s += e.amt;
  return s;
}
