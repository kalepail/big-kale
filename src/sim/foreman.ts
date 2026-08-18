import {
  HOME,
  JOB_STATS,
  MAP_H,
  MAP_W,
  MAX_AGENTS,
  TERRAIN,
  type JobKind,
} from "./constants";
import { plotAt, sumWindow } from "./farm";
import { designate, fireAgent, hireAgent, promoteAgent, setSpeed } from "./ops";
import { jobPolicy, parseJobFile } from "./policy";
import type { Desire, FarmAgent, FarmState, Policy } from "./types";

const FOREMAN_PERIOD = 2;

const PATCH: Record<Exclude<keyof Policy, "waitAtBarn">, string> = {
  plant: "Also till and plant empty dirt.",
  tend: "Also tend growing plots.",
  harvest: "Also harvest ripe kale so it does not wilt.",
  haul: "Also haul loose kale to the barn.",
  build: "Also build designated plots.",
};

const EXPAND_DIRS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export function stepForeman(farm: FarmState, dt: number): void {
  if (!farm.foreman) return;
  farm.foreman.thinking = false;
  farm.foreman.cooldown -= dt;
  if (farm.foreman.cooldown > 0) return;
  farm.foreman.cooldown = FOREMAN_PERIOD;
  act(farm);
}

function act(farm: FarmState): void {
  const queued = farm.desires
    .filter((d) => d.status === "queued")
    .sort((a, b) => a.id - b.id);
  if (queued[0]) {
    applyDesire(farm, queued[0]);
    return;
  }

  const yieldPerMin = sumWindow(farm.yieldEvents, farm.simTime);
  const spendPerMin = farm.agents.reduce((s, a) => s + a.burn, 0);
  const netPerMin = yieldPerMin - spendPerMin;

  if (farm.ripeCount >= 1 && !anyone(farm, "harvest")) {
    const note = ensureCoverage(farm, "harvester", "harvest");
    say(farm, note.thought, note.lastAct);
    return;
  }

  if (farm.groundCount >= 1 && !anyone(farm, "haul")) {
    const note = ensureCoverage(farm, "hauler", "haul");
    say(farm, note.thought, note.lastAct);
    return;
  }

  const plantable = realPlots(farm).filter(
    (p) => p.state === "empty" || p.state === "tilled" || p.state === "wilted",
  );
  if (plantable.length && !anyone(farm, "plant")) {
    const note = ensureCoverage(farm, "planter", "plant");
    say(farm, note.thought, note.lastAct);
    return;
  }

  const needsTend = realPlots(farm).some(
    (p) => (p.state === "planted" || p.state === "growing") && p.tended < 1,
  );
  if (needsTend && !anyone(farm, "tend")) {
    const hasWorker = farm.agents.some((a) => a.job === "worker");
    if (!hasWorker) {
      const hired = tryHire(farm, "worker");
      if (hired) {
        say(farm, hired.thought, hired.lastAct);
        return;
      }
    }
  }

  if (farm.kale > 40) {
    const promo = tryPromoteSpecialist(farm);
    if (promo) {
      say(farm, promo.thought, promo.lastAct);
      return;
    }
  }

  const emptyCount = realPlots(farm).filter((p) => p.state === "empty").length;
  if (netPerMin > 0 && farm.kale > 25 && (emptyCount < 4 || homeOccupied(farm))) {
    const tiles = findExpandTiles(farm, 4);
    if (tiles.length) {
      for (const t of tiles) designate(farm, t.x, t.y, "build");
      let extra = `marked ${tiles.length} grass tiles. grow bigger.`;
      if (!anyone(farm, "build")) {
        const cov = ensureCoverage(farm, "builder", "build");
        extra = cov.lastAct;
      }
      say(farm, "the field is too small. east and south it is.", extra);
      return;
    }
  }

  if (farm.agents.length > 3 && spendPerMin > yieldPerMin + 0.2) {
    const fired = fireIdleExtra(farm);
    if (fired) {
      say(farm, fired.thought, fired.lastAct);
      return;
    }
  }

  say(farm, statusThought(farm, netPerMin), farm.foreman.lastAct || "watching the dirt");
}

function applyDesire(farm: FarmState, d: Desire): void {
  d.status = "doing";
  const note = parseDesire(farm, d.text);
  d.status = "done";
  d.note = note.lastAct;
  say(farm, note.thought, note.lastAct);
}

function parseDesire(farm: FarmState, text: string): { thought: string; lastAct: string } {
  const t = text.toLowerCase();

  const hireM = t.match(/\bhire\s+(planter|worker|harvester|hauler|builder)\b/);
  if (hireM) {
    const job = hireM[1] as JobKind;
    return tryHire(farm, job) ?? {
      thought: `wanted a ${job}. wallet said no.`,
      lastAct: `could not hire ${job}`,
    };
  }

  if (/fire idle|too many/.test(t)) {
    return (
      fireIdleExtra(farm) ?? {
        thought: "nobody extra to fire. the barn is already lean.",
        lastAct: "no idle extra to fire",
      }
    );
  }

  if (/\b10x\b/.test(t)) {
    setSpeed(farm, 10);
    return { thought: "faster. kale goes brrr.", lastAct: "speed 10x" };
  }
  if (/\b3x\b/.test(t)) {
    setSpeed(farm, 3);
    return { thought: "a little haste.", lastAct: "speed 3x" };
  }
  if (/\b1x\b/.test(t)) {
    setSpeed(farm, 1);
    return { thought: "slow is smooth. smooth is kale.", lastAct: "speed 1x" };
  }
  if (/\bfaster\b/.test(t)) {
    const next = farm.speed === 1 ? 3 : 10;
    setSpeed(farm, next);
    return { thought: `sped up to ${next}x. try and keep up.`, lastAct: `speed ${next}x` };
  }

  if (/expand|more dirt|more plots|bigger/.test(t)) {
    const tiles = findExpandTiles(farm, 6);
    for (const tile of tiles) designate(farm, tile.x, tile.y, "build");
    let lastAct = tiles.length ? `build marks on ${tiles.length} tiles` : "no grass left to eat";
    if (!anyone(farm, "build")) {
      const cov = ensureCoverage(farm, "builder", "build");
      lastAct = `${lastAct}; ${cov.lastAct}`;
    }
    return { thought: "more dirt. ambition smells like soil.", lastAct };
  }

  const focusM = t.match(/\bfocus\s+(plant|tend|harvest|haul|build|planter|worker|harvester|hauler|builder)\b/);
  if (focusM) {
    const verb = normalizeVerb(focusM[1]);
    const line = PATCH[verb];
    for (const a of farm.agents) patchAgent(a, line);
    return {
      thought: `everyone, ${verb}. no arguments.`,
      lastAct: `focused all pails on ${verb}`,
    };
  }

  if (/harvest|rot|wilt|ripe/.test(t)) {
    const cov = ensureCoverage(farm, "harvester", "harvest");
    return { thought: "rot is not a personality.", lastAct: cov.lastAct };
  }
  if (/haul|barn|piles|ground/.test(t)) {
    const cov = ensureCoverage(farm, "hauler", "haul");
    return { thought: "piles on the ground offend me.", lastAct: cov.lastAct };
  }
  if (/plant|seed|sow/.test(t)) {
    const cov = ensureCoverage(farm, "planter", "plant");
    return { thought: "empty dirt is a dare.", lastAct: cov.lastAct };
  }
  if (/tend|work|water/.test(t)) {
    const hasWorker = farm.agents.some((a) => a.job === "worker");
    if (!anyone(farm, "tend") && !hasWorker) {
      const hired = tryHire(farm, "worker");
      if (hired) return hired;
    }
    if (!anyone(farm, "tend")) {
      const cov = ensureCoverage(farm, "worker", "tend");
      return { thought: "someone water the divas.", lastAct: cov.lastAct };
    }
    return { thought: "already tending. the plants are spoiled.", lastAct: "tend coverage already ok" };
  }

  for (const a of farm.agents) patchAgent(a, `# ${text}`);
  return {
    thought: "pinned a note on every pail. they will pretend to read it.",
    lastAct: `note on all files: ${text.slice(0, 80)}`,
  };
}

function ensureCoverage(
  farm: FarmState,
  job: JobKind,
  key: Exclude<keyof Policy, "waitAtBarn">,
): { thought: string; lastAct: string } {
  if (anyone(farm, key)) {
    return { thought: `${key} is covered. try not to mess it up.`, lastAct: `${key} already covered` };
  }
  const hired = tryHire(farm, job);
  if (hired) return hired;
  const target = idleEst(farm);
  if (target) {
    patchAgent(target, PATCH[key]);
    target.policy = { ...target.policy, [key]: true };
    return {
      thought: `broke to hire. patched ${target.name} instead.`,
      lastAct: `patched ${target.name} for ${key}`,
    };
  }
  return { thought: "nobody left to patch. lonely barn.", lastAct: `no coverage for ${key}` };
}

function tryHire(farm: FarmState, job: JobKind): { thought: string; lastAct: string } | null {
  if (farm.agents.length >= MAX_AGENTS) return null;
  const cost = JOB_STATS[job].hire;
  if (farm.kale < cost) return null;
  const res = hireAgent(farm, job);
  if (!res.ok || !res.agent) return null;
  return {
    thought: `${res.agent.name} the ${job} clocked in. don't make me regret this.`,
    lastAct: res.msg,
  };
}


function tryPromoteSpecialist(farm: FarmState): { thought: string; lastAct: string } | null {
  const cand = farm.agents
    .filter(
      (a) =>
        a.action.type === "idle" &&
        (a.job === "harvester" || a.job === "planter") &&
        (a.rank || 1) < 3,
    )
    .sort((a, b) => b.idleSince - a.idleSince);
  const target = cand[0];
  if (!target) return null;
  const res = promoteAgent(farm, target.id);
  if (!res.ok) return null;
  return {
    thought: `promoted ${target.name} instead of hiring a clone tender.`,
    lastAct: res.msg,
  };
}

function fireIdleExtra(farm: FarmState): { thought: string; lastAct: string } | null {
  const planters = farm.agents.filter((a) => a.job === "planter").length;
  const candidates = farm.agents
    .filter((a) => a.idleSince > 15)
    .filter((a) => !(a.job === "planter" && planters <= 1))
    .sort((a, b) => b.idleSince - a.idleSince);
  const target = candidates[0];
  if (!target) return null;
  const res = fireAgent(farm, target.id);
  if (!res.ok) return null;
  return {
    thought: `${target.name} was furniture. expensive furniture.`,
    lastAct: res.msg,
  };
}

function patchAgent(agent: FarmAgent, line: string): void {
  if (!agent.jobFile.includes(line)) {
    agent.jobFile = `${agent.jobFile.trimEnd()}\n${line}\n`.slice(0, 4000);
  }
  agent.policy = jobPolicy(agent.job, agent.jobFile);
  agent.thought = "foreman rewrote my file. rude.";
}

const SPECIALIST: Record<Exclude<keyof Policy, "waitAtBarn">, JobKind> = {
  plant: "planter",
  tend: "worker",
  harvest: "harvester",
  haul: "hauler",
  build: "builder",
};

function mentionsVerb(jobFile: string, key: keyof Policy): boolean {
  return parseJobFile(jobFile)[key] === true;
}

function anyone(farm: FarmState, key: keyof Policy): boolean {
  return farm.agents.some((a) => {
    if (key !== "waitAtBarn" && a.job === SPECIALIST[key]) return true;
    return a.policy[key] && mentionsVerb(a.jobFile, key);
  });
}

function idleEst(farm: FarmState): FarmAgent | undefined {
  return [...farm.agents].sort((a, b) => b.idleSince - a.idleSince)[0];
}

function realPlots(farm: FarmState) {
  return farm.plots.filter((p) => farm.terrain[p.y * MAP_W + p.x] === TERRAIN.dirt);
}

function homeOccupied(farm: FarmState): boolean {
  for (let y = HOME.y; y < HOME.y + HOME.h; y++) {
    for (let x = HOME.x; x < HOME.x + HOME.w; x++) {
      const p = plotAt(farm, x, y);
      if (!p || p.state === "empty" || p.state === "tilled" || p.state === "wilted") return false;
    }
  }
  return true;
}

function findExpandTiles(farm: FarmState, want: number): Array<{ x: number; y: number }> {
  const dirt: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (farm.terrain[y * MAP_W + x] === TERRAIN.dirt) dirt.push({ x, y });
    }
  }
  dirt.sort((a, b) => b.x + b.y - (a.x + a.y) || b.x - a.x);
  const out: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  for (const d of dirt) {
    for (const [dx, dy] of EXPAND_DIRS) {
      const x = d.x + dx;
      const y = d.y + dy;
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
      const t = farm.terrain[y * MAP_W + x];
      if (t === TERRAIN.barn || t === TERRAIN.well || t === TERRAIN.dirt) continue;
      if (t !== TERRAIN.grass && t !== TERRAIN.path) continue;
      const p = plotAt(farm, x, y);
      if (p && (p.designation === "build" || farm.terrain[p.y * MAP_W + p.x] === TERRAIN.dirt)) continue;
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x, y });
      if (out.length >= want) return out;
    }
  }
  return out;
}

function normalizeVerb(raw: string): Exclude<keyof Policy, "waitAtBarn"> {
  if (raw === "planter") return "plant";
  if (raw === "worker") return "tend";
  if (raw === "harvester") return "harvest";
  if (raw === "hauler") return "haul";
  if (raw === "builder") return "build";
  return raw as Exclude<keyof Policy, "waitAtBarn">;
}

function statusThought(farm: FarmState, net: number): string {
  if (farm.ripeCount) return `${farm.ripeCount} ripe. someone better be cutting.`;
  if (farm.groundCount) return `${farm.groundCount} piles sulking on the dirt.`;
  if (farm.wiltCount) return `${farm.wiltCount} wilted. we had one job.`;
  if (net > 0) return `net +${net.toFixed(1)}/min. human, go touch grass.`;
  return `barn brain watching. ${farm.agents.length} pails, ${farm.kale.toFixed(0)} kale.`;
}

function say(farm: FarmState, thought: string, lastAct: string): void {
  farm.foreman.thought = thought.slice(0, 120);
  farm.foreman.lastAct = lastAct.slice(0, 120);
}
