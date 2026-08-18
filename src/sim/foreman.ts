import {
  DEFAULT_ROOT_PROMPT,
  HOME,
  JOB_STATS,
  MAP_H,
  MAP_W,
  MAX_AGENTS,
  PILES_PER_HAULER,
  RIPE_PER_HARVESTER,
  TERRAIN,
  type JobKind,
} from "./constants";
import { plotAt, sumWindow } from "./farm";
import { designate, fireAgent, hireAgent, promoteAgent, setSpeed } from "./ops";
import { jobPolicy, parseJobFile } from "./policy";
import type { Desire, FarmAgent, FarmState, Policy } from "./types";

const FOREMAN_PERIOD = 2;

type FarmIntent = {
  isDefault: boolean;
  wantExpand: boolean;
  neverWilt: boolean;
  maxPails: number;
  preferPromote: boolean;
};

function parseFarmIntent(text: string): FarmIntent {
  const raw = (text || "").trim();
  const isDefault = !raw || raw === DEFAULT_ROOT_PROMPT.trim();
  if (isDefault) {
    return {
      isDefault: true,
      wantExpand: true,
      neverWilt: false,
      maxPails: MAX_AGENTS,
      preferPromote: true,
    };
  }
  const t = raw.toLowerCase();
  const maxM = t.match(/\bmax(?:imum)?\s+(\d+)\b/);
  const maxPails = maxM ? Math.max(1, Math.min(MAX_AGENTS, parseInt(maxM[1], 10))) : MAX_AGENTS;
  return {
    isDefault: false,
    wantExpand: /\bexpand\b|\bbigger\b|more (dirt|plots)/.test(t),
    neverWilt:
      /\bnever let kale (wilt|rot)\b/.test(t) ||
      /\bnever (let )?(it )?(wilt|rot)\b/.test(t) ||
      /\b(never|don'?t|do not)\b[\s\S]{0,28}\b(wilt|rot)\b/.test(t),
    maxPails,
    preferPromote: /\bpromote\b/.test(t),
  };
}

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

  const intent = parseFarmIntent(farm.rootPrompt);
  const yieldPerMin = sumWindow(farm.yieldEvents, farm.simTime);
  const spendPerMin = farm.agents.reduce((s, a) => s + a.burn, 0);
  const netPerMin = yieldPerMin - spendPerMin;
  const harvestPressure = farm.ripeCount >= 1 || (intent.neverWilt && farm.wiltCount >= 1);
  const crisis = harvestPressure || farm.groundCount >= 1;
  const rawHarv = rawWantHarvesters(farm);
  const wantHarv = wantHarvesters(farm);
  const wantHaul = wantHaulers(farm);

  if (farm.ripeCount > 0 && countJob(farm, "harvester") < wantHarv) {
    const note = staffUp(farm, "harvester", wantHarv);
    if (note) {
      say(farm, note.thought, note.lastAct);
      return;
    }
  }

  if (farm.ripeCount > 0 && countJob(farm, "harvester") < rawHarv) {
    const patched = patchHarvest(farm);
    if (patched) {
      say(farm, patched.thought, patched.lastAct);
      return;
    }
  }

  if (farm.groundCount > 0 && countJob(farm, "hauler") < wantHaul) {
    const note = staffUp(farm, "hauler", wantHaul);
    if (note) {
      say(farm, note.thought, note.lastAct);
      return;
    }
    const patched = patchHaul(farm);
    if (patched) {
      say(farm, patched.thought, patched.lastAct);
      return;
    }
  }

  if (crisis) {
    const promoFloor = intent.isDefault || !intent.preferPromote ? 40 : 10;
    if (farm.kale > promoFloor) {
      const promo = tryPromoteBottleneck(farm);
      if (promo) {
        say(farm, promo.thought, promo.lastAct);
        return;
      }
    }
    say(farm, statusThought(farm, netPerMin), farm.foreman.lastAct || "buying the line");
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
  if (intent.wantExpand && netPerMin > 0 && farm.kale > 25 && (emptyCount < 4 || homeOccupied(farm))) {
    const tiles = findExpandTiles(farm, 4);
    if (tiles.length) {
      for (const tile of tiles) designate(farm, tile.x, tile.y, "build");
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
    return { thought: "already staffing tend — watching growth", lastAct: "already staffing tend — watching growth" };
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
    const watching: Record<string, string> = {
      harvest: "already staffing harvest — watching wilt",
      haul: "already staffing haul — watching piles",
      plant: "already staffing plant — watching empty dirt",
      tend: "already staffing tend — watching growth",
      build: "already staffing build — watching grass",
    };
    const note = watching[key] || `already staffing ${key}`;
    return { thought: note, lastAct: note };
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
  const cap = Math.min(MAX_AGENTS, parseFarmIntent(farm.rootPrompt).maxPails);
  if (farm.agents.length >= cap) return null;
  const cost = JOB_STATS[job].hire;
  if (farm.kale < cost) return null;
  const res = hireAgent(farm, job);
  if (!res.ok || !res.agent) return null;
  return {
    thought: `${res.agent.name} the ${job} clocked in. don't make me regret this.`,
    lastAct: res.msg,
  };
}


function countJob(farm: FarmState, job: JobKind): number {
  return farm.agents.filter((a) => a.job === job).length;
}

function rawWantHarvesters(farm: FarmState): number {
  if (farm.ripeCount <= 0) return 0;
  return Math.max(1, Math.ceil(farm.ripeCount / RIPE_PER_HARVESTER));
}

function affordableHeadcount(farm: FarmState, job: JobKind, raw: number): number {
  const have = countJob(farm, job);
  const cost = JOB_STATS[job].hire;
  const cap = Math.min(MAX_AGENTS, parseFarmIntent(farm.rootPrompt).maxPails);
  const room = Math.max(0, cap - farm.agents.length);
  const canPay = cost > 0 ? Math.floor(farm.kale / cost) : 0;
  return have + Math.min(Math.max(0, raw - have), room, canPay);
}

function wantHarvesters(farm: FarmState): number {
  const raw = rawWantHarvesters(farm);
  if (raw <= 0) return countJob(farm, "harvester");
  return Math.max(countJob(farm, "harvester"), Math.min(raw, affordableHeadcount(farm, "harvester", raw)));
}

function wantHaulers(farm: FarmState): number {
  if (farm.groundCount <= 0) return countJob(farm, "hauler");
  const byPiles = Math.ceil(farm.groundCount / PILES_PER_HAULER);
  const byRatio = countJob(farm, "harvester");
  return Math.max(1, byPiles, byRatio);
}

function staffUp(farm: FarmState, job: JobKind, want: number): { thought: string; lastAct: string } | null {
  if (countJob(farm, job) >= want) return null;
  return tryHire(farm, job);
}

function patchHarvest(farm: FarmState): { thought: string; lastAct: string } | null {
  const target = [...farm.agents]
    .filter((a) => a.job !== "harvester")
    .filter((a) => !a.policy.harvest)
    .sort((a, b) => {
      if (a.job === "planter" && b.job !== "planter") return -1;
      if (b.job === "planter" && a.job !== "planter") return 1;
      return b.idleSince - a.idleSince;
    })[0];
  if (!target) return null;
  patchAgent(target, PATCH.harvest);
  target.policy = { ...target.policy, harvest: true };
  return {
    thought: `broke to hire. patched ${target.name} to harvest.`,
    lastAct: `patched ${target.name} for harvest`,
  };
}

function patchHaul(farm: FarmState): { thought: string; lastAct: string } | null {
  const harvesters = countJob(farm, "harvester");
  const target = [...farm.agents]
    .filter((a) => a.job !== "hauler")
    .filter((a) => !(a.job === "harvester" && harvesters <= 1))
    .filter((a) => !a.policy.haul)
    .sort((a, b) => b.idleSince - a.idleSince)[0];
  if (!target) return null;
  patchAgent(target, PATCH.haul);
  target.policy = { ...target.policy, haul: true };
  return {
    thought: `broke to hire. patched ${target.name} to haul.`,
    lastAct: `patched ${target.name} for haul`,
  };
}

function tryPromoteBottleneck(farm: FarmState): { thought: string; lastAct: string } | null {
  const preferHauler = farm.groundCount > farm.ripeCount;
  const cand = farm.agents
    .filter((a) => (a.job === "hauler" || a.job === "harvester") && (a.rank || 1) < 3)
    .sort((a, b) => {
      if (a.job !== b.job) {
        if (preferHauler) return a.job === "hauler" ? -1 : 1;
        return a.job === "harvester" ? -1 : 1;
      }
      return (a.rank || 1) - (b.rank || 1);
    });
  const target = cand[0];
  if (!target) return null;
  const res = promoteAgent(farm, target.id);
  if (!res.ok) return null;
  return {
    thought: `promoted ${target.name} the ${target.job}. bottleneck specialist.`,
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
  if (farm.ripeCount > 0 || farm.groundCount > 0) return null;
  const planters = farm.agents.filter((a) => a.job === "planter").length;
  const candidates = farm.agents
    .filter((a) => a.idleSince > 15)
    .filter((a) => a.job !== "hauler" && a.job !== "harvester")
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
  const nHaul = countJob(farm, "hauler");
  const nHarv = countJob(farm, "harvester");
  const wantHaul = wantHaulers(farm);
  const wantHarv = wantHarvesters(farm);
  if (farm.groundCount) return `${farm.groundCount} piles, ${nHaul}/${wantHaul} haulers. buying the line.`;
  if (farm.ripeCount) return `${farm.ripeCount} ripe, ${nHarv}/${wantHarv} harvesters. buying the line.`;
  if (farm.wiltCount) return `${farm.wiltCount} wilted. we had one job.`;
  if (net > 0) return `net +${net.toFixed(1)}/min. human, go touch grass.`;
  return `barn brain watching. ${farm.agents.length} pails, ${farm.kale.toFixed(0)} kale.`;
}

function say(farm: FarmState, thought: string, lastAct: string): void {
  if (!farm.foreman.holdUntil || Date.now() >= farm.foreman.holdUntil) {
    farm.foreman.thought = thought.slice(0, 120);
  }
  farm.foreman.lastAct = lastAct.slice(0, 120);
}
