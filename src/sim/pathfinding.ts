import { MAP_H, MAP_W, TERRAIN } from "./constants";

export function walkable(terrain: number[], x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
  const t = terrain[y * MAP_W + x];
  return t === TERRAIN.grass || t === TERRAIN.dirt || t === TERRAIN.path;
}

export function astar(
  terrain: number[],
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): { x: number; y: number }[] | null {
  const startX = Math.round(sx);
  const startY = Math.round(sy);
  const goalX = tx;
  const goalY = ty;
  if (!walkable(terrain, goalX, goalY)) return null;
  if (startX === goalX && startY === goalY) return [{ x: goalX, y: goalY }];

  const key = (x: number, y: number) => y * MAP_W + x;
  const open: number[] = [key(startX, startY)];
  const came = new Int32Array(MAP_W * MAP_H).fill(-1);
  const gScore = new Float32Array(MAP_W * MAP_H).fill(1e9);
  const fScore = new Float32Array(MAP_W * MAP_H).fill(1e9);
  const inOpen = new Uint8Array(MAP_W * MAP_H);
  gScore[key(startX, startY)] = 0;
  fScore[key(startX, startY)] = Math.abs(goalX - startX) + Math.abs(goalY - startY);
  inOpen[key(startX, startY)] = 1;

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let steps = 0;
  const maxSteps = MAP_W * MAP_H;

  while (open.length && steps++ < maxSteps) {
    let bestI = 0;
    let bestF = fScore[open[0]];
    for (let i = 1; i < open.length; i++) {
      const f = fScore[open[i]];
      if (f < bestF) {
        bestF = f;
        bestI = i;
      }
    }
    const current = open[bestI];
    open[bestI] = open[open.length - 1];
    open.pop();
    inOpen[current] = 0;
    const cx = current % MAP_W;
    const cy = (current / MAP_W) | 0;
    if (cx === goalX && cy === goalY) {
      const path: { x: number; y: number }[] = [];
      let c = current;
      while (c !== -1) {
        path.push({ x: c % MAP_W, y: (c / MAP_W) | 0 });
        c = came[c];
      }
      path.reverse();
      return path;
    }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!walkable(terrain, nx, ny)) continue;
      const nk = key(nx, ny);
      const tent = gScore[current] + 1;
      if (tent < gScore[nk]) {
        came[nk] = current;
        gScore[nk] = tent;
        fScore[nk] = tent + Math.abs(goalX - nx) + Math.abs(goalY - ny);
        if (!inOpen[nk]) {
          open.push(nk);
          inOpen[nk] = 1;
        }
      }
    }
  }
  return null;
}

export function nearestWalkable(
  terrain: number[],
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (walkable(terrain, x, y)) return { x, y };
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (walkable(terrain, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return null;
}

export function barnDoor(): { x: number; y: number } {
  return { x: 20, y: 21 };
}
