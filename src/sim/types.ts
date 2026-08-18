import type { JobKind } from "./constants";

export type Designation = "plant" | "tend" | "harvest" | "haul" | "build";
export type PlotState = "empty" | "tilled" | "planted" | "growing" | "ripe" | "wilted";

export interface Policy {
  plant: boolean;
  tend: boolean;
  harvest: boolean;
  haul: boolean;
  build: boolean;
  waitAtBarn: boolean;
}

export interface ForcedOrder {
  kind: Designation;
  x: number;
  y: number;
}

export type AgentAction =
  | { type: "idle" }
  | { type: "walk"; path: Point[]; i: number; after: Exclude<AgentAction, { type: "walk" | "idle" }> | { type: "idle" } }
  | { type: "work"; kind: "till" | "plant" | "tend" | "harvest" | "build" | "pickup" | "drop"; x: number; y: number; t: number; dur: number }
  | { type: "carry"; amount: number };

export interface Point {
  x: number;
  y: number;
}

export interface FarmAgent {
  id: string;
  name: string;
  job: JobKind;
  x: number;
  y: number;
  burn: number;
  jobFile: string;
  policy: Policy;
  action: AgentAction;
  forced: ForcedOrder | null;
  idleSince: number;
  carrying: number;
  thinking: boolean;
  thought: string;
  rank: number;
}

export interface Plot {
  x: number;
  y: number;
  state: PlotState;
  growth: number;
  yield: number;
  wilt: number;
  tended: number;
  designation: Designation | null;
  claimedBy: string | null;
  groundKale: number;
}

export interface LedgerEvent {
  t: number;
  amt: number;
}

export interface Desire {
  id: number;
  text: string;
  t: number;
  status: "queued" | "doing" | "done";
  note: string;
}

export interface ForemanState {
  thought: string;
  lastAct: string;
  cooldown: number;
  thinking: boolean;
}

export interface FarmState {
  tick: number;
  simTime: number;
  speed: 1 | 3 | 10;
  kale: number;
  terrain: number[];
  plots: Plot[];
  agents: FarmAgent[];
  nextAgentId: number;
  nextName: number;
  yieldEvents: LedgerEvent[];
  spendEvents: LedgerEvent[];
  barnStock: number;
  ripeCount: number;
  wiltCount: number;
  groundCount: number;
  rootPrompt: string;
  desires: Desire[];
  nextDesireId: number;
  foreman: ForemanState;
}

export interface HudRates {
  kale: number;
  yieldPerMin: number;
  spendPerMin: number;
  netPerMin: number;
  agents: number;
  idle: number;
  ripe: number;
  wilted: number;
  ground: number;
  unused: number;
  bottleneck: "rot" | "haul" | "plant" | "ok";
  staff: { planter: number; worker: number; harvester: number; hauler: number; builder: number };
}

export interface Snapshot {
  type: "snap";
  tick: number;
  simTime: number;
  speed: 1 | 3 | 10;
  hud: HudRates;
  barn: { x: number; y: number; w: number; h: number; stock: number };
  well: { x: number; y: number };
  plots: Plot[];
  agents: Array<{
    id: string;
    name: string;
    job: JobKind;
    x: number;
    y: number;
    burn: number;
    jobFile: string;
    action: string;
    detail: string;
    carrying: number;
    idle: boolean;
    thinking: boolean;
    thought: string;
    forced: ForcedOrder | null;
    rank: number;
  }>;
  idleIds: string[];
  rootPrompt: string;
  desires: Desire[];
  foreman: { thought: string; lastAct: string; thinking: boolean };
}

export interface MapMessage {
  type: "map";
  w: number;
  h: number;
  terrain: number[];
  barn: { x: number; y: number; w: number; h: number };
  well: { x: number; y: number };
}

export interface ThinkView {
  id: string;
  job: JobKind;
  jobFile: string;
  action: string;
  idleSeconds: number;
  kale: number;
  ripeCount: number;
  wiltCount: number;
  groundCount: number;
  nearby: Array<{ x: number; y: number; state: string; designation: string | null; groundKale: number }>;
}

export interface ThinkResult {
  policy: Policy;
  note: string;
  usage: { input: number; output: number };
  model: string;
  skipped: boolean;
  kaleCost: number;
}
