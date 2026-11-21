// How a CPU finds its way over a stage with pits and bridges: a coarse grid of safe standing
// points laid over the stage's floor (stages.ts), shortest walks across it, and "is the straight
// walk clear" checks. Pure and deterministic, importable in node (tests).

import { canStandAtStage, hasClearance, STAGES, type StageId } from "./stages";
import type { Vec2 } from "./types";

/** Nodes sit on the integer lattice from -9 to 9: tile centres and bridge centre lines are on it. */
const SPAN = 9;
const SIDE = SPAN * 2 + 1;
/** A node keeps this much floor around it, so a walk from node to node never skirts a drop. */
const NODE_MARGIN = 0.45;
/** A fighter steps on to the grid at a node this close. */
const JOIN_RANGE = 1.6;
/** How many nodes ahead along the path a walker may cut straight to. */
const LOOK_AHEAD = 8;

interface NavGrid {
  /** The nodes that can be stood on, as indices into the lattice. */
  nodes: number[];
  /** For each lattice index, the nodes one step away and what the step costs. */
  links: { to: number; cost: number }[][];
  /** Walking distance from every node to a goal node, by goal; worked out when first asked for. */
  fields: Map<number, Float32Array>;
}

const grids = new Map<string, NavGrid>();
const nodeX = (index: number): number => (index % SIDE) - SPAN;
const nodeZ = (index: number): number => Math.floor(index / SIDE) - SPAN;
const nodePoint = (index: number): Vec2 => ({ x: nodeX(index), z: nodeZ(index) });
const indexOf = (x: number, z: number): number => (z + SPAN) * SIDE + (x + SPAN);

const unit = (x: number, z: number): Vec2 => {
  const d = Math.hypot(x, z);
  return d > 0.00001 ? { x: x / d, z: z / d } : { x: 0, z: 0 };
};

function navGrid(stageId: StageId, halfSize: number): NavGrid {
  const key = `${stageId}/${halfSize}`;
  let grid = grids.get(key);
  if (grid) return grid;
  const valid = new Uint8Array(SIDE * SIDE);
  const nodes: number[] = [];
  for (let z = -SPAN; z <= SPAN; z++) {
    for (let x = -SPAN; x <= SPAN; x++) {
      if (!hasClearance(stageId, x, z, halfSize, NODE_MARGIN)) continue;
      valid[indexOf(x, z)] = 1;
      nodes.push(indexOf(x, z));
    }
  }
  const at = (x: number, z: number): boolean =>
    Math.abs(x) <= SPAN && Math.abs(z) <= SPAN && valid[indexOf(x, z)] === 1;
  const links: NavGrid["links"] = Array.from({ length: SIDE * SIDE }, () => []);
  for (const index of nodes) {
    const x = nodeX(index);
    const z = nodeZ(index);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dz === 0) || !at(x + dx, z + dz)) continue;
        // No cutting a corner over a gap: a diagonal step needs both of its straight neighbours.
        if (dx !== 0 && dz !== 0 && !(at(x + dx, z) && at(x, z + dz))) continue;
        if (!canStandAtStage(stageId, x + dx / 2, z + dz / 2, halfSize)) continue;
        links[index]!.push({
          to: indexOf(x + dx, z + dz),
          cost: dx !== 0 && dz !== 0 ? Math.SQRT2 : 1,
        });
      }
    }
  }
  grid = { nodes, links, fields: new Map() };
  grids.set(key, grid);
  return grid;
}

/** Walking distance from every node to `goal` (Dijkstra; the graph has a few hundred nodes). */
function fieldTo(grid: NavGrid, goal: number): Float32Array {
  let field = grid.fields.get(goal);
  if (field) return field;
  field = new Float32Array(SIDE * SIDE).fill(Infinity);
  field[goal] = 0;
  const open = new Set(grid.nodes);
  while (open.size > 0) {
    let current = -1;
    let nearest = Infinity;
    for (const index of open) {
      if (field[index]! < nearest) {
        nearest = field[index]!;
        current = index;
      }
    }
    if (current < 0) break;
    open.delete(current);
    for (const link of grid.links[current]!) {
      const through = nearest + link.cost;
      if (through < field[link.to]!) field[link.to] = through;
    }
  }
  grid.fields.set(goal, field);
  return field;
}

function nearestNode(grid: NavGrid, point: Vec2): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const index of grid.nodes) {
    const distance = Math.hypot(nodeX(index) - point.x, nodeZ(index) - point.z);
    if (distance < bestDistance - 1e-9) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Is the straight walk from `from` to `to` over floor all the way, with `margin` of floor to
 * spare on both sides? `from` itself is not checked: the walker is already there.
 */
export function clearWalk(
  stageId: StageId,
  halfSize: number,
  from: Vec2,
  to: Vec2,
  margin = 0.3,
): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.00001) return canStandAtStage(stageId, to.x, to.z, halfSize);
  const sideX = (-dz / distance) * margin;
  const sideZ = (dx / distance) * margin;
  const steps = Math.ceil(distance / 0.25);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (dx * i) / steps;
    const z = from.z + (dz * i) / steps;
    if (
      !canStandAtStage(stageId, x, z, halfSize) ||
      !canStandAtStage(stageId, x + sideX, z + sideZ, halfSize) ||
      !canStandAtStage(stageId, x - sideX, z - sideZ, halfSize)
    )
      return false;
  }
  return true;
}

/**
 * Walking distance from `from` to `goal` along the floor (through the nearest nodes of each), or
 * Infinity when no walk joins them. Straight distance on a solid stage.
 */
export function walkDistance(stageId: StageId, halfSize: number, from: Vec2, goal: Vec2): number {
  if (STAGES[stageId].solid) return Math.hypot(goal.x - from.x, goal.z - from.z);
  const grid = navGrid(stageId, halfSize);
  const a = nearestNode(grid, from);
  const b = nearestNode(grid, goal);
  if (a < 0 || b < 0) return Infinity;
  return fieldTo(grid, b)[a]!;
}

/**
 * Which way to walk to get from `from` to `goal` without leaving the floor: straight when the
 * way is clear, otherwise along the shortest walk round the pits and over the bridges, cutting
 * corners only where the cut is over floor. A zero vector means "stay": the goal is over a gap
 * and this is as close as the floor gets.
 */
export function routeDirection(stageId: StageId, halfSize: number, from: Vec2, goal: Vec2): Vec2 {
  const straight = unit(goal.x - from.x, goal.z - from.z);
  if (STAGES[stageId].solid || clearWalk(stageId, halfSize, from, goal)) return straight;
  const grid = navGrid(stageId, halfSize);
  const goalNode = nearestNode(grid, goal);
  if (goalNode < 0) return straight;
  const field = fieldTo(grid, goalNode);
  // Step on to the grid at the node that leaves the shortest way to go.
  let start = -1;
  let shortest = Infinity;
  for (const index of grid.nodes) {
    const distance = Math.hypot(nodeX(index) - from.x, nodeZ(index) - from.z);
    if (distance > JOIN_RANGE || !Number.isFinite(field[index]!)) continue;
    if (distance > 0.05 && !clearWalk(stageId, halfSize, from, nodePoint(index), 0.2)) continue;
    if (distance + field[index]! < shortest - 1e-9) {
      shortest = distance + field[index]!;
      start = index;
    }
  }
  if (start < 0) {
    // On a rim or in the air, where no node can be walked to safely: make for the nearest one.
    const near = nearestNode(grid, from);
    return near < 0 ? straight : unit(nodeX(near) - from.x, nodeZ(near) - from.z);
  }
  // Follow the walk and aim at the farthest node of it that is a clear straight line away.
  let target = start;
  let first = -1;
  let node = start;
  for (let hop = 0; hop < LOOK_AHEAD && node !== goalNode; hop++) {
    let next = -1;
    let left = Infinity;
    for (const link of grid.links[node]!) {
      const through = field[link.to]! + link.cost;
      if (through < left - 1e-6) {
        left = through;
        next = link.to;
      }
    }
    if (next < 0) break;
    if (first < 0) first = next;
    node = next;
    if (!clearWalk(stageId, halfSize, from, nodePoint(node), 0.25)) break;
    target = node;
  }
  if (Math.hypot(nodeX(target) - from.x, nodeZ(target) - from.z) > 0.1)
    return unit(nodeX(target) - from.x, nodeZ(target) - from.z);
  // Standing on the node: on along the path, or nowhere when this is the end of it.
  return first < 0 ? { x: 0, z: 0 } : unit(nodeX(first) - from.x, nodeZ(first) - from.z);
}
