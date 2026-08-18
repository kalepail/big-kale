# Big Kale v0 plan

## Pitch

The player is the only human on a farm. They do not farm. They write markdown job files. Agents (pails) plant, work, and harvest KALE. Running agents costs KALE. The win condition is a dashboard that prints KALE while you watch.

Not Smallville-with-crops. An economy. RimWorld priorities on an AoE farm, Paperclips for the HUD, Farmer-Was-Replaced files as the only deep verb.

## Player verbs (ranked)

1. Edit file
2. Queue order
3. Hire / fire
4. Inspect
5. Pan camera

If the player has to path units, v0 has failed.

## Loop

1. See the leak (idle badge, wilt, spend/min).
2. Inspect a pail or a tile.
3. Edit a markdown job file or queue one order.
4. Hire / rebalance headcount. Every pail has a burn.
5. Watch compounding. Net/min > 0 grows the farm. Spend > yield is bankruptcy as boss.

## Jobs

- Planter: till + plant, burn 0.4/min, hire 10
- Worker: tend growing plots (yield up), burn 0.6/min, hire 15
- Harvester: cut ripe kale onto the tile, burn 0.55/min, hire 15
- Hauler: carry piles to the barn (the wallet), burn 0.4/min, hire 12
- Builder: turn designated grass into plots, burn 0.9/min, hire 20

Jobs live on tiles. Pails claim them with deterministic A-star. Idle badge cycles people.

## Sim

- 48x48 orthographic tilemap, 10 Hz physics.
- Grow about 32s plus 12s ripe window, about 45s at 1x.
- Wilt if you do not harvest.
- Speed 1 / 3 / 10.
- Max 8 agents.
- Start: 40 KALE, one idle Planter, empty home plots, barn, well.

## LLM (optional)

Never in the walk loop. World physics is authoritative.

Called when a job file is saved, or a pail is idle about 8s with nothing claimable.

KaleAgent DOs run env.AI.run luna through gateway id default, reasoning effort none, max_output_tokens 96. Fallback llama-fast. Debit KALE from token usage. Skip if the farm cannot afford it.

Default files plus a keyword compiler keep the farm playable with the brain unplugged.

## Architecture

Browser SPA talks WebSocket to World DO kale-1. World RPCs think() to KaleAgent DOs. 10 Hz alarm, no LLM on World. 5 Hz snapshot broadcast.

Cloudflare Worker plus static assets. run_worker_first for /api/* and /agents/*. One World Agents-SDK Durable Object plus N KaleAgent sqlite DOs. No Sandbox containers, no wallets, no multiplayer, no agent chat.

## v0 done when

A stranger can produce a self-running 5-pail farm without clicking tiles every harvest, and can explain the bottleneck from the HUD alone.
