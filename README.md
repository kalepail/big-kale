# Big Kale

You are the only human on a farm. You do not farm. You write markdown job files. Pails plant, tend, harvest, and haul KALE. Running pails costs KALE.

KALE is an in-game resource. There is no wallet, no chain, no token.

## Play

1. 48x48 farm, barn, well, dirt plots, one idle Planter, 40 KALE.
2. Designate Plant on dirt (or wait: default planter.md tills home plots).
3. Click the planter, edit the job file, Save to replan.
4. Hire Worker / Harvester / Hauler when ripe kale or ground piles appear.
5. Yellow idle badge (or I) cycles idle pails.
6. You never path a unit.

Jobs: Planter, Worker, Harvester, Hauler, Builder. Max 8. Grow cycle about 45s at 1x. Ripe kale wilts. Speed 1x / 3x / 10x.

## Run locally

Install Node deps, then run the `dev` script from package.json (starts wrangler). Open http://localhost:8787.

Run `npx wrangler login` once. Needed for deploy and the AI binding.

The farm is playable with default job files and designations. The LLM is optional. It compiles a job file into a policy and unsticks idle pails. Never in the walk loop.

## Deploy

Run the `deploy` script from package.json. Needs Workers Paid (Durable Objects).

## AI (optional)

- Binding: env.AI.run with AI Gateway id `default`.
- `default` is auto-created on the first authenticated request (auth on, logs on, cache off).
- Primary: openai/gpt-5.6-luna, Responses API (`input` not `messages`), reasoning.effort none, max_output_tokens 96.
- Fallback: @cf/meta/llama-3.1-8b-instruct-fast.
- Unified Billing for Luna: dashboard, AI, AI Gateway, top up credits. After first request, set Workers AI billing on default to Unified if you also want hosted models on the same wallet.
- No API keys in the Worker. The ai binding carries account identity.

Token usage is converted into KALE and debited. If a pail cannot afford a think, skip the LLM and keep the default policy.

## Layout

- src/index.ts — Worker: /api/world/* and /agents/*
- src/world.ts — World Durable Object (room kale-1): physics, jobs, broadcast
- src/kale-agent.ts — KaleAgent DO: optional LLM policy compile
- src/sim/* — Deterministic 10 Hz farm (A*, growth, claim)
- public/ — Canvas SPA (camera, HUD, inspect, job files)

World instance name is kale-1. Snapshots over WebSocket. Client applies snapshots. Physics on the World alarm; agents think elsewhere.

## Controls

- WASD / arrows / drag: pan
- Wheel: zoom
- Click tile: inspect + current designation
- Click pail: inspect + job file
- Idle button / I: cycle idle pails
- Ctrl-click tile (pail selected): queue an order
- Minimap: jump camera

See PLAN.md for the design.
