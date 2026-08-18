export const MAP_W = 48;
export const MAP_H = 48;
export const TICK_HZ = 10;
export const TICK_DT = 1 / TICK_HZ;
export const MAX_AGENTS = 32;
export const MAX_RANK = 5;
export const START_KALE = 40;
export const GROW_TIME = 32;
export const WILT_TIME = 48;
export const WALK_SPEED = 3.6;
export const LLM_IDLE_SECONDS = 8;
export const LLM_MIN_KALE = 1;
export const KALE_PER_USD = 10_000;
export const LUNA_IN_PER_M = 0.2;
export const LUNA_OUT_PER_M = 1.2;
export const CREDIT_FEE = 1.05;
export const ROOM_ID = "kale-1";
export const PILES_PER_HAULER = 6;
export const RIPE_PER_HARVESTER = 5;
export const MAX_CARRY = 4;

export const TERRAIN = {
  grass: 0,
  dirt: 1,
  barn: 2,
  well: 3,
  path: 4,
} as const;

export type TerrainId = (typeof TERRAIN)[keyof typeof TERRAIN];

export const JOBS = ["planter", "worker", "harvester", "hauler", "builder"] as const;
export type JobKind = (typeof JOBS)[number];

export const JOB_STATS: Record<
  JobKind,
  { hire: number; burn: number; label: string; band: string }
> = {
  planter: { hire: 10, burn: 0.4, label: "Planter", band: "#7cfc00" },
  worker: { hire: 15, burn: 0.6, label: "Worker", band: "#f4d35e" },
  harvester: { hire: 15, burn: 0.55, label: "Harvester", band: "#e85d04" },
  hauler: { hire: 12, burn: 0.4, label: "Hauler", band: "#4cc9f0" },
  builder: { hire: 20, burn: 0.9, label: "Builder", band: "#b5651d" },
};

export const WORK_TIME: Record<string, number> = {
  till: 1.2,
  plant: 1.0,
  tend: 1.5,
  harvest: 1.2,
  pickup: 0.4,
  drop: 0.3,
  build: 2.5,
};

export const PAIL_NAMES = [
  "Pail",
  "Dipper",
  "Scoop",
  "Tin",
  "Jug",
  "Kettle",
  "Can",
  "Bucket",
];

export const DEFAULT_JOB_FILES: Record<JobKind, string> = {
  planter: `# planter.md
When you see untilled soil in the home plots, till and plant kale.
If no soil is free, stand at the barn and wait.
`,
  worker: `# worker.md
Tend the most-grown plot that isn't fully worked.
Time on a tile raises yield. Then wait at the barn.
`,
  harvester: `# harvester.md
Never let ripe kale wilt. Cut ripe kale onto the tile.
If nothing is ripe, wait at the barn.
`,
  hauler: `# hauler.md
Keep the ground clear. Haul loose kale to the barn first.
If nothing to haul, wait at the barn.
`,
  builder: `# builder.md
Build the player's designated plots, then idle at the barn.
`,
};

export const BARN = { x: 21, y: 18, w: 3, h: 3 };
export const WELL = { x: 18, y: 20 };
export const HOME = { x: 25, y: 21, w: 4, h: 5 };

export const DEFAULT_ROOT_PROMPT = `# farm.md
You are the Foreman. The human does not farm.
Grow KALE. Inventory on the dirt is not income until it hits the barn.
WireBuyer rules:
- If ripe plots > 5 per harvester, hire another harvester.
- If ground piles > 6 per hauler, or piles exist and haulers < harvesters, hire another hauler.
- Do not expand or promote planters while ripe or piles are backlogged.
- Promote the bottleneck specialist (hauler/harvester) before hiring a clone of a covered job.
- Max 32. Never let ripe kale wilt.
`;
