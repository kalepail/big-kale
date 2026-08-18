import {
  BARN,
  JOB_STATS,
  MAP_H,
  MAP_W,
  MAX_AGENTS,
  TERRAIN,
  type JobKind,
} from "./constants";
import { emptyPlot, plotAt, spawnAgent } from "./farm";
import { barnDoor } from "./pathfinding";
import { jobPolicy } from "./policy";
import type { Designation, FarmAgent, FarmState, ForcedOrder, Plot } from "./types";

export function unclaim(plot: Plot, id: string): void {
  if (plot.claimedBy === id) plot.claimedBy = null;
}

export function designate(farm: FarmState, x: number, y: number, kind: Designation | null): string {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return "out of bounds";
  const t = farm.terrain[y * MAP_W + x];
  if (t === TERRAIN.barn || t === TERRAIN.well) return "that's a building, not a job";
  if (kind === "build") {
    if (t === TERRAIN.dirt) return "already a plot";
    let p = plotAt(farm, x, y);
    if (!p) {
      p = emptyPlot(x, y);
      p.designation = "build";
      farm.plots.push(p);
    } else {
      p.designation = "build";
    }
    return `build marked at ${x},${y}`;
  }
  let p = plotAt(farm, x, y);
  if (!p) {
    if (t !== TERRAIN.dirt) return "not a plot — use Build on grass";
    p = emptyPlot(x, y);
    farm.plots.push(p);
  }
  p.designation = kind;
  return kind ? `${kind} marked at ${x},${y}` : `cleared ${x},${y}`;
}

export function hireAgent(farm: FarmState, job: JobKind): { ok: boolean; msg: string; agent?: FarmAgent } {
  if (farm.agents.length >= MAX_AGENTS) return { ok: false, msg: "max 32 pails. promote before you clone." };
  const stats = JOB_STATS[job];
  if (farm.kale < stats.hire) return { ok: false, msg: `need ${stats.hire} KALE to hire a ${stats.label}` };
  farm.kale -= stats.hire;
  farm.spendEvents.push({ t: farm.simTime, amt: stats.hire });
  const door = barnDoor();
  const agent = spawnAgent(farm.nextAgentId++, job, door.x + 0.3, door.y + 0.6, farm.nextName++);
  farm.agents.push(agent);
  return { ok: true, msg: `hired ${agent.name} the ${stats.label} (−${stats.hire} KALE)`, agent };
}

export function fireAgent(farm: FarmState, id: string): { ok: boolean; msg: string } {
  const i = farm.agents.findIndex((a) => a.id === id);
  if (i < 0) return { ok: false, msg: "no such pail" };
  const agent = farm.agents[i];
  for (const p of farm.plots) if (p.claimedBy === id) p.claimedBy = null;
  farm.agents.splice(i, 1);
  return { ok: true, msg: `fired ${agent.name}. the pail is empty.` };
}

export function saveJob(farm: FarmState, id: string, markdown: string): { ok: boolean; msg: string; agent?: FarmAgent } {
  const agent = farm.agents.find((a) => a.id === id);
  if (!agent) return { ok: false, msg: "no such pail" };
  agent.jobFile = markdown.slice(0, 4000);
  agent.policy = jobPolicy(agent.job, agent.jobFile);
  if (agent.action.type === "idle") agent.idleSince = 0;
  agent.thought = "re-reading the file. new orders.";
  return { ok: true, msg: "job file saved. replanning.", agent };
}

export function queueOrder(
  farm: FarmState,
  agentId: string,
  order: ForcedOrder,
): { ok: boolean; msg: string } {
  const agent = farm.agents.find((a) => a.id === agentId);
  if (!agent) return { ok: false, msg: "no such pail" };
  if (agent.action.type === "work") {
    const plot = plotAt(farm, agent.action.x, agent.action.y);
    if (plot) unclaim(plot, agent.id);
  } else if (agent.action.type === "walk" && "x" in agent.action.after && "y" in agent.action.after) {
    const after = agent.action.after as { x?: number; y?: number };
    if (typeof after.x === "number" && typeof after.y === "number") {
      const plot = plotAt(farm, after.x, after.y);
      if (plot) unclaim(plot, agent.id);
    }
  }
  agent.forced = order;
  agent.action = { type: "idle" };
  agent.thought = `queued ${order.kind} at ${order.x},${order.y}`;
  return { ok: true, msg: agent.thought };
}

export function setSpeed(farm: FarmState, speed: 1 | 3 | 10): void {
  farm.speed = speed;
}

export { BARN };

const ROMAN = ["I", "II", "III", "IV", "V"];

export function romanRank(rank: number): string {
  const r = Math.max(1, Math.min(5, Math.floor(rank || 1)));
  return ROMAN[r - 1];
}

export function promoteCost(rank: number): number {
  return 10 * Math.max(1, Math.floor(rank || 1));
}

export function rankFactor(rank: number): number {
  const r = Math.max(1, Math.min(5, Math.floor(rank || 1)));
  return 1 + 0.25 * (r - 1);
}

export function promoteAgent(farm: FarmState, id: string): { ok: boolean; msg: string; agent?: FarmAgent } {
  const agent = farm.agents.find((a) => a.id === id);
  if (!agent) return { ok: false, msg: "no such pail" };
  const rank = Math.max(1, Math.min(5, Math.floor(agent.rank || 1)));
  agent.rank = rank;
  if (rank >= 5) return { ok: false, msg: `${agent.name} is already Pail V. the ceiling.` };
  const cost = promoteCost(rank);
  if (farm.kale < cost) return { ok: false, msg: `need ${cost} KALE to promote ${agent.name}` };
  farm.kale -= cost;
  farm.spendEvents.push({ t: farm.simTime, amt: cost });
  agent.rank = rank + 1;
  agent.thought = `promoted to Pail ${romanRank(agent.rank)}. still a bucket.`;
  return { ok: true, msg: `promoted ${agent.name} to Pail ${romanRank(agent.rank)} (−${cost} KALE)`, agent };
}
