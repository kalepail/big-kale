import { Agent, type Connection, getAgentByName } from "agents";
import { JOBS, LLM_IDLE_SECONDS, LLM_MIN_KALE, TICK_DT, type JobKind } from "./sim/constants";
import { createFarm } from "./sim/farm";
import { toMap, toSnapshot } from "./sim/snapshot";
import {
  designate,
  fireAgent,
  hireAgent,
  queueOrder,
  saveJob,
  setSpeed,
  stepFarm,
} from "./sim/tick";
import type { Designation, FarmState, ThinkView } from "./sim/types";
import type { KaleAgent } from "./kale-agent";

type Persist = { farm: FarmState };

export class World extends Agent<Env, Persist> {
  initialState: Persist = { farm: createFarm() };
  farm: FarmState | null = null;
  lastBroadcast = 0;
  thinking = new Set<string>();

  async onStart(): Promise<void> {
    this.farm = this.state?.farm ?? createFarm();
    await this.scheduleEvery(0.1, "onSimTick");
  }

  async onSimTick(): Promise<void> {
    try {
      const farm = this.ensureFarm();
      const steps = farm.speed;
      for (let i = 0; i < steps; i++) stepFarm(farm, TICK_DT);
      this.lastBroadcast++;
      if (this.lastBroadcast % 2 === 0) this.pushSnap();
      if (this.lastBroadcast % 20 === 0) this.persist();
      this.maybeUnstick();
    } catch (err) {
      console.error("sim tick failed", err);
    }
  }

  ensureFarm(): FarmState {
    if (!this.farm) this.farm = this.state?.farm ?? createFarm();
    return this.farm;
  }

  persist(): void {
    this.setState({ farm: this.ensureFarm() });
  }

  pushSnap(): void {
    const farm = this.ensureFarm();
    const snap = toSnapshot(farm);
    this.broadcast(JSON.stringify(snap));
  }

  pushMap(connection?: Connection): void {
    const msg = JSON.stringify(toMap(this.ensureFarm()));
    if (connection) connection.send(msg);
    else this.broadcast(msg);
  }

  async onConnect(connection: Connection): Promise<void> {
    this.pushMap(connection);
    connection.send(JSON.stringify(toSnapshot(this.ensureFarm())));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (typeof data.type === "string" && data.type.startsWith("cf_")) return;
    const result = await this.handleCommand(data);
    connection.send(JSON.stringify({ type: "ack", ...result }));
    this.pushSnap();
    if (data.type === "designate" && data.kind === "build") this.pushMap(connection);
  }

  async onRequest(request: Request): Promise<Response> {
    const farm = this.ensureFarm();
    if (request.method === "GET") {
      return Response.json({ map: toMap(farm), snap: toSnapshot(farm) });
    }
    if (request.method === "POST") {
      const data = await request.json().catch(() => ({}));
      const result = await this.handleCommand(data);
      this.pushSnap();
      return Response.json(result);
    }
    return new Response("nope", { status: 405 });
  }

  async handleCommand(data: any): Promise<{ ok: boolean; msg: string; extra?: unknown }> {
    const farm = this.ensureFarm();
    const type = String(data.type ?? data.cmd ?? "");
    try {
      if (type === "ping") return { ok: true, msg: "pong" };
      if (type === "hire") {
        const job = String(data.job) as JobKind;
        if (!JOBS.includes(job)) return { ok: false, msg: "unknown job" };
        const res = hireAgent(farm, job);
        this.persist();
        return { ok: res.ok, msg: res.msg, extra: res.agent ? { id: res.agent.id } : undefined };
      }
      if (type === "fire") {
        const res = fireAgent(farm, String(data.id));
        this.persist();
        return res;
      }
      if (type === "designate") {
        const kind = data.kind == null || data.kind === "clear" ? null : (String(data.kind) as Designation);
        const msg = designate(farm, Number(data.x), Number(data.y), kind);
        this.persist();
        return { ok: true, msg };
      }
      if (type === "saveJob") {
        const res = saveJob(farm, String(data.id), String(data.markdown ?? ""));
        this.persist();
        if (res.ok && res.agent) this.compileLater(res.agent.id);
        return { ok: res.ok, msg: res.msg };
      }
      if (type === "speed") {
        const s = Number(data.speed);
        if (s === 1 || s === 3 || s === 10) setSpeed(farm, s);
        return { ok: true, msg: `speed ${farm.speed}x` };
      }
      if (type === "queue") {
        const res = queueOrder(farm, String(data.agentId), {
          kind: String(data.kind) as Designation,
          x: Number(data.x),
          y: Number(data.y),
        });
        this.persist();
        return res;
      }
      if (type === "reset") {
        this.farm = createFarm();
        this.persist();
        this.broadcast(JSON.stringify(toMap(this.farm)));
        return { ok: true, msg: "farm reset. one lonely planter. 40 kale." };
      }
      return { ok: false, msg: `unknown command ${type}` };
    } catch (err) {
      return { ok: false, msg: String(err) };
    }
  }

  maybeUnstick(): void {
    const farm = this.ensureFarm();
    if (farm.kale < LLM_MIN_KALE) return;
    for (const agent of farm.agents) {
      if (this.thinking.size >= 2) break;
      if (agent.thinking || this.thinking.has(agent.id)) continue;
      if (agent.action.type !== "idle") continue;
      if (agent.idleSince < LLM_IDLE_SECONDS) continue;
      this.compileLater(agent.id);
    }
  }

  compileLater(agentId: string): void {
    if (this.thinking.has(agentId)) return;
    this.thinking.add(agentId);
    void this.compile(agentId).finally(() => this.thinking.delete(agentId));
  }

  async compile(agentId: string): Promise<void> {
    const farm = this.ensureFarm();
    const agent = farm.agents.find((a) => a.id === agentId);
    if (!agent) return;
    if (farm.kale < LLM_MIN_KALE) return;
    agent.thinking = true;
    agent.thought = "thinking… (not walking. walking is free.)";
    try {
      const stub = (await getAgentByName(this.env.KaleAgent, agent.id)) as unknown as KaleAgent;
      const view: ThinkView = {
        id: agent.id,
        job: agent.job,
        jobFile: agent.jobFile,
        action: agent.action.type,
        idleSeconds: agent.idleSince,
        kale: farm.kale,
        ripeCount: farm.ripeCount,
        wiltCount: farm.wiltCount,
        groundCount: farm.groundCount,
        nearby: nearbyPlots(farm, agent.x, agent.y),
      };
      const result = await stub.think(view, agent.policy, farm.kale);
      const live = farm.agents.find((a) => a.id === agentId);
      if (!live) return;
      if (result.skipped) {
        live.thought = result.note;
        live.thinking = false;
        return;
      }
      const cost = Math.max(0.1, result.kaleCost || 0);
      if (farm.kale < cost) {
        live.thought = "thought too expensive. staying stubborn.";
        live.thinking = false;
        return;
      }
      farm.kale -= cost;
      farm.spendEvents.push({ t: farm.simTime, amt: cost });
      live.policy = result.policy;
      live.thought = result.note || "file compiled. back to dirt.";
      live.thinking = false;
      live.idleSince = 0;
    } catch (err) {
      const live = farm.agents.find((a) => a.id === agentId);
      if (live) {
        live.thinking = false;
        live.thought = "brain offline. default file still works.";
      }
      console.error("compile failed", err);
    }
  }
}

function nearbyPlots(farm: FarmState, x: number, y: number) {
  const tx = Math.round(x);
  const ty = Math.round(y);
  return farm.plots
    .filter((p) => Math.abs(p.x - tx) <= 4 && Math.abs(p.y - ty) <= 4)
    .slice(0, 16)
    .map((p) => ({
      x: p.x,
      y: p.y,
      state: p.state,
      designation: p.designation,
      groundKale: p.groundKale,
    }));
}
