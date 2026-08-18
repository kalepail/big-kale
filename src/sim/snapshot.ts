import { BARN, WELL } from "./constants";
import { sumWindow } from "./farm";
import type { FarmState, MapMessage, Snapshot } from "./types";

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
  const idle = farm.agents.filter((a) => a.action.type === "idle");
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
      };
    }),
    idleIds: idle.map((a) => a.id),
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
