import {
  BARN,
  GROW_TIME,
  JOB_STATS,
  MAP_H,
  MAP_W,
  MAX_AGENTS,
  TERRAIN,
  WILT_TIME,
  WALK_SPEED,
  WORK_TIME,
  type JobKind,
} from "./constants";
import { emptyPlot, plotAt, pruneLedger, spawnAgent } from "./farm";
import { astar, barnDoor, nearestWalkable, walkable } from "./pathfinding";
import { jobPolicy } from "./policy";
import type { AgentAction, Designation, FarmAgent, FarmState, ForcedOrder, Plot } from "./types";

const DIRS: Designation[] = ["plant", "tend", "harvest", "haul", "build"];

export function stepFarm(farm: FarmState, dt: number): void {
  farm.tick++;
  farm.simTime += dt;
  growPlots(farm, dt);
  burnKale(farm, dt);
  for (const agent of farm.agents) {
    stepAgent(farm, agent, dt);
  }
  for (const agent of farm.agents) {
    if (agent.action.type === "idle") claimJob(farm, agent);
  }
  recount(farm);
  pruneLedger(farm);
}

function growPlots(farm: FarmState, dt: number): void {
  for (const p of farm.plots) {
    if (p.state === "planted" || p.state === "growing") {
      p.growth += dt / GROW_TIME;
      if (p.state === "planted" && p.growth > 0.08) p.state = "growing";
      if (p.growth >= 1) {
        p.growth = 1;
        p.state = "ripe";
        p.wilt = WILT_TIME;
      }
    } else if (p.state === "ripe") {
      p.wilt -= dt;
      if (p.wilt <= 0) {
        p.state = "wilted";
        p.wilt = 0;
        p.yield = 0;
      }
    }
  }
}

function burnKale(farm: FarmState, dt: number): void {
  let burn = 0;
  for (const a of farm.agents) burn += a.burn;
  const spent = (burn * dt) / 60;
  if (spent > 0) {
    farm.kale = Math.max(0, farm.kale - spent);
    farm.spendEvents.push({ t: farm.simTime, amt: spent });
  }
}

function stepAgent(farm: FarmState, agent: FarmAgent, dt: number): void {
  const act = agent.action;
  if (act.type === "idle") {
    agent.idleSince += dt;
    return;
  }
  agent.idleSince = 0;
  if (act.type === "walk") {
    const node = act.path[act.i];
    if (!node) {
      agent.action = act.after;
      return;
    }
    const speed = farm.kale <= 0 ? WALK_SPEED * 0.5 : WALK_SPEED;
    const dx = node.x + 0.5 - agent.x;
    const dy = node.y + 0.5 - agent.y;
    const dist = Math.hypot(dx, dy);
    const step = speed * dt;
    if (dist <= step + 0.05) {
      agent.x = node.x + 0.5;
      agent.y = node.y + 0.5;
      act.i++;
      if (act.i >= act.path.length) agent.action = act.after;
    } else {
      agent.x += (dx / dist) * step;
      agent.y += (dy / dist) * step;
    }
    return;
  }
  if (act.type === "work") {
    act.t += dt;
    if (act.t >= act.dur) finishWork(farm, agent, act);
  }
}

function finishWork(
  farm: FarmState,
  agent: FarmAgent,
  act: Extract<AgentAction, { type: "work" }>,
): void {
  const plot = plotAt(farm, act.x, act.y);
  if (act.kind === "till" && plot) {
    plot.state = "tilled";
    plot.growth = 0;
    plot.yield = 1;
    plot.tended = 0;
    plot.wilt = 0;
  } else if (act.kind === "plant" && plot) {
    plot.state = "planted";
    plot.growth = 0;
    plot.yield = 1;
    plot.tended = 0;
    if (plot.designation === "plant") plot.designation = null;
  } else if (act.kind === "tend" && plot) {
    if (plot.tended < 3 && (plot.state === "planted" || plot.state === "growing")) {
      plot.tended++;
      plot.yield = Math.min(2.2, plot.yield + 0.2);
      plot.growth = Math.min(1, plot.growth + 0.04);
    }
    if (plot.designation === "tend") plot.designation = null;
  } else if (act.kind === "harvest" && plot) {
    if (plot.state === "ripe") {
      plot.groundKale += Math.max(0.4, plot.yield);
      plot.state = "empty";
      plot.growth = 0;
      plot.yield = 1;
      plot.tended = 0;
      plot.wilt = 0;
    }
    if (plot.designation === "harvest") plot.designation = null;
  } else if (act.kind === "pickup" && plot) {
    const amt = plot.groundKale;
    plot.groundKale = 0;
    if (plot.designation === "haul") plot.designation = null;
    if (amt > 0) {
      agent.carrying += amt;
      const door = barnDoor();
      goDo(farm, agent, door.x, door.y, {
        type: "work",
        kind: "drop",
        x: door.x,
        y: door.y,
        t: 0,
        dur: WORK_TIME.drop,
      });
      unclaim(plot, agent.id);
      return;
    }
  } else if (act.kind === "drop") {
    if (agent.carrying > 0) {
      farm.kale += agent.carrying;
      farm.barnStock += agent.carrying;
      farm.yieldEvents.push({ t: farm.simTime, amt: agent.carrying });
      agent.carrying = 0;
    }
  } else if (act.kind === "build") {
    buildPlot(farm, act.x, act.y);
    if (plot) plot.designation = null;
  }
  if (plot) unclaim(plot, agent.id);
  agent.action = { type: "idle" };
  agent.thought = idleThought(agent);
}

function buildPlot(farm: FarmState, x: number, y: number): void {
  const i = y * MAP_W + x;
  if (farm.terrain[i] === TERRAIN.barn || farm.terrain[i] === TERRAIN.well) return;
  farm.terrain[i] = TERRAIN.dirt;
  if (!plotAt(farm, x, y)) farm.plots.push(emptyPlot(x, y));
}

function unclaim(plot: Plot, id: string): void {
  if (plot.claimedBy === id) plot.claimedBy = null;
}

function goDo(
  farm: FarmState,
  agent: FarmAgent,
  x: number,
  y: number,
  after: Exclude<AgentAction, { type: "walk" }>,
): void {
  const dest = nearestWalkable(farm.terrain, x, y) ?? { x, y };
  const path = astar(farm.terrain, agent.x, agent.y, dest.x, dest.y);
  if (!path || path.length === 0) {
    agent.action = after;
    return;
  }
  agent.action = { type: "walk", path, i: 0, after };
}

function claimJob(farm: FarmState, agent: FarmAgent): void {
  if (agent.carrying > 0) {
    const door = barnDoor();
    goDo(farm, agent, door.x, door.y, {
      type: "work",
      kind: "drop",
      x: door.x,
      y: door.y,
      t: 0,
      dur: WORK_TIME.drop,
    });
    agent.thought = "barn. wallet. same building.";
    return;
  }
  if (agent.forced) {
    const order = agent.forced;
    if (tryOrder(farm, agent, order)) {
      agent.forced = null;
      return;
    }
  }
  const wants = wantedKinds(agent);
  for (const kind of wants) {
    const target = findTarget(farm, agent, kind);
    if (target && takeTarget(farm, agent, kind, target)) return;
  }
  if (agent.policy.waitAtBarn) {
    const door = barnDoor();
    const dist = Math.hypot(agent.x - (door.x + 0.5), agent.y - (door.y + 0.5));
    if (dist > 1.2) {
      goDo(farm, agent, door.x, door.y, { type: "idle" });
      agent.thought = "nothing to do. lurking by the barn.";
    }
  }
}

function wantedKinds(agent: FarmAgent): Designation[] {
  const p = agent.policy;
  const list: Designation[] = [];
  if (p.plant) list.push("plant");
  if (p.tend) list.push("tend");
  if (p.harvest) list.push("harvest");
  if (p.haul) list.push("haul");
  if (p.build) list.push("build");
  if (agent.job === "planter" && !list.includes("plant")) list.unshift("plant");
  return list;
}

function findTarget(
  farm: FarmState,
  agent: FarmAgent,
  kind: Designation,
): { x: number; y: number } | null {
  if (kind === "build") {
    const marked = farm.plots
      .filter((p) => p.designation === "build" && !p.claimedBy)
      .sort((a, b) => dist2(agent, a) - dist2(agent, b));
    if (marked[0]) return marked[0];
    return findBuildMarks(farm, agent);
  }

  const scored: Plot[] = [];
  for (const p of farm.plots) {
    if (p.claimedBy) continue;
    if (kind === "plant") {
      const designated = p.designation === "plant";
      const auto = p.designation == null && (p.state === "empty" || p.state === "tilled" || p.state === "wilted");
      if ((designated || auto) && (p.state === "empty" || p.state === "tilled" || p.state === "wilted")) {
        scored.push(p);
      }
    } else if (kind === "tend") {
      if (
        (p.designation === "tend" || p.designation == null) &&
        (p.state === "planted" || p.state === "growing") &&
        p.tended < 3
      ) {
        scored.push(p);
      }
    } else if (kind === "harvest") {
      if ((p.designation === "harvest" || p.designation == null) && p.state === "ripe") scored.push(p);
    } else if (kind === "haul") {
      if ((p.designation === "haul" || p.designation == null) && p.groundKale > 0) scored.push(p);
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => {
    const da = a.designation === kind ? 0 : 1;
    const db = b.designation === kind ? 0 : 1;
    if (da !== db) return da - db;
    if (kind === "tend") return b.growth - a.growth || dist2(agent, a) - dist2(agent, b);
    if (kind === "harvest") return a.wilt - b.wilt || dist2(agent, a) - dist2(agent, b);
    return dist2(agent, a) - dist2(agent, b);
  });
  return scored[0];
}

function findBuildMarks(farm: FarmState, agent: FarmAgent): { x: number; y: number } | null {
  let best: Plot | null = null;
  let bestD = 1e9;
  for (const p of farm.plots) {
    if (p.designation !== "build" || p.claimedBy) continue;
    const d = dist2(agent, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function takeTarget(
  farm: FarmState,
  agent: FarmAgent,
  kind: Designation,
  target: { x: number; y: number },
): boolean {
  const plot = plotAt(farm, target.x, target.y);
  if (kind === "build") {
    if (plot) plot.claimedBy = agent.id;
    goDo(farm, agent, target.x, target.y, {
      type: "work",
      kind: "build",
      x: target.x,
      y: target.y,
      t: 0,
      dur: WORK_TIME.build,
    });
    agent.thought = `building a plot at ${target.x},${target.y}`;
    return true;
  }
  if (!plot) return false;
  plot.claimedBy = agent.id;
  if (kind === "plant") {
    const workKind = plot.state === "tilled" ? "plant" : "till";
    goDo(farm, agent, plot.x, plot.y, {
      type: "work",
      kind: workKind,
      x: plot.x,
      y: plot.y,
      t: 0,
      dur: WORK_TIME[workKind],
    });
    agent.thought = workKind === "till" ? "tilling. very official." : "planting oversized leaves.";
  } else if (kind === "tend") {
    goDo(farm, agent, plot.x, plot.y, {
      type: "work",
      kind: "tend",
      x: plot.x,
      y: plot.y,
      t: 0,
      dur: WORK_TIME.tend,
    });
    agent.thought = "working the plot. proof of teamwork.";
  } else if (kind === "harvest") {
    goDo(farm, agent, plot.x, plot.y, {
      type: "work",
      kind: "harvest",
      x: plot.x,
      y: plot.y,
      t: 0,
      dur: WORK_TIME.harvest,
    });
    agent.thought = "cutting kale before it sulks.";
  } else if (kind === "haul") {
    goDo(farm, agent, plot.x, plot.y, {
      type: "work",
      kind: "pickup",
      x: plot.x,
      y: plot.y,
      t: 0,
      dur: WORK_TIME.pickup,
    });
    agent.thought = "hauling. barn first. always barn first.";
  }
  return true;
}

function tryOrder(farm: FarmState, agent: FarmAgent, order: ForcedOrder): boolean {
  if (order.kind === "build") {
    return takeTarget(farm, agent, "build", order);
  }
  const plot = plotAt(farm, order.x, order.y);
  if (!plot || plot.claimedBy) return false;
  return takeTarget(farm, agent, order.kind, plot);
}

function dist2(agent: FarmAgent, p: { x: number; y: number }): number {
  const dx = agent.x - (p.x + 0.5);
  const dy = agent.y - (p.y + 0.5);
  return dx * dx + dy * dy;
}

function recount(farm: FarmState): void {
  let ripe = 0,
    wilt = 0,
    ground = 0;
  for (const p of farm.plots) {
    if (p.state === "ripe") ripe++;
    if (p.state === "wilted") wilt++;
    if (p.groundKale > 0) ground++;
  }
  farm.ripeCount = ripe;
  farm.wiltCount = wilt;
  farm.groundCount = ground;
}

function idleThought(agent: FarmAgent): string {
  const bits = [
    "idle. yellow badge of shame.",
    "waiting on a file that isn't this one.",
    "counting dirt.",
    "the well is full of opinions.",
  ];
  return bits[agent.id.length % bits.length];
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
  if (farm.agents.length >= MAX_AGENTS) return { ok: false, msg: "max 8 pails. this is not a town." };
  const stats = JOB_STATS[job];
  if (farm.kale < stats.hire) return { ok: false, msg: `need ${stats.hire} KALE to hire a ${stats.label}` };
  farm.kale -= stats.hire;
  farm.spendEvents.push({ t: farm.simTime, amt: stats.hire });
  const door = barnDoor();
  const agent = spawnAgent(farm.nextAgentId++, job, door.x + 0.3, door.y + 0.6, farm.nextName++);
  farm.agents.push(agent);
  return { ok: true, msg: `hired ${agent.name} the ${stats.label}`, agent };
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

export { DIRS, JOB_STATS };
