import { BARN, WELL, type JobKind } from "./constants";
import { sumWindow } from "./farm";
import type { FarmState, HudRates, MapMessage, Snapshot } from "./types";

export function actionLabel(farmAgentAction: FarmState["agents"][number]["action"]): { action: string; detail: string } {
  const a = farmAgentAction;
  if (a.type === "idle") return { action: "idle", detail: "standing around" };
  if (a.type === "walk") {
    const after = a.after;
    const next = after.type === "work" ? after.kind : after.type;
    return { action: "walk", detail: `to ${next}` };
  }
  if (a.type === "work") return { action: a.kind, detail: `${a.kind} @ ${a.x},${a.y}` };
  if (a.type === "carry") return { action: "carry", detail: `carrying ${a.amount.toFixed(1)}` };
  return { action: "idle", detail: "" };
}

export function toSnapshot(farm: FarmState): Snapshot {
  const yieldPerMin = sumWindow(farm.yieldEvents, farm.simTime);
  const spendBurn = farm.agents.reduce((s, a) => s + a.burn, 0);
  const spendWindow = sumWindow(farm.spendEvents, farm.simTime);
  const idle = farm.agents.filter((a) => a.action.type === "idle");
  const staff: HudRates["staff"] = { planter: 0, worker: 0, harvester: 0, hauler: 0, builder: 0 };
  let unused = 0;
  let emptyDirt = 0;
  for (const plot of farm.plots) {
    unused += plot.groundKale;
    if (plot.state === "empty" || plot.state === "wilted" || plot.state === "tilled") emptyDirt++;
  }
  for (const a of farm.agents) staff[a.job as JobKind]++;
  let bottleneck: HudRates["bottleneck"] = "ok";
  if (farm.ripeCount >= 3 || (farm.ripeCount >= 1 && staff.harvester === 0)) bottleneck = "rot";
  else if (farm.groundCount >= 3) bottleneck = "haul";
  else if (emptyDirt >= 6 && staff.planter === 0) bottleneck = "plant";
  return {
    type: "snap",
    tick: farm.tick,
    simTime: farm.simTime,
    speed: farm.speed,
    hud: {
      kale: farm.kale,
      yieldPerMin,
      spendPerMin: spendBurn,
      netPerMin: yieldPerMin - spendBurn,
      agents: farm.agents.length,
      idle: idle.length,
      ripe: farm.ripeCount,
      wilted: farm.wiltCount,
      ground: farm.groundCount,
      unused,
      bottleneck,
      staff,
    },
    barn: { ...BARN, stock: farm.barnStock },
    well: { ...WELL },
    plots: farm.plots,
    agents: farm.agents.map((a) => {
      const { action, detail } = actionLabel(a.action);
      return {
        id: a.id,
        name: a.name,
        job: a.job,
        x: a.x,
        y: a.y,
        burn: a.burn,
        jobFile: a.jobFile,
        action,
        detail,
        carrying: a.carrying,
        idle: a.action.type === "idle",
        thinking: a.thinking,
        thought: a.thought,
        forced: a.forced,
        rank: a.rank || 1,
      };
    }),
    idleIds: idle.map((a) => a.id),
    rootPrompt: farm.rootPrompt || "",
    desires: (farm.desires || []).slice(-12),
    foreman: {
      thought: farm.foreman?.thought || "",
      lastAct: farm.foreman?.lastAct || "",
      thinking: !!farm.foreman?.thinking,
    },
  };
}

export function toMap(farm: FarmState): MapMessage {
  return {
    type: "map",
    w: 48,
    h: 48,
    terrain: farm.terrain,
    barn: { ...BARN },
    well: { ...WELL },
  };
}
