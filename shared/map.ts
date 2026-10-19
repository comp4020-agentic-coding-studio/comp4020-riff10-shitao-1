// The one map, Kiln, as data: a grid of cells, each open floor, wall or
// crate. Collision, line of sight, spawns, bomb sites, buy zones and the
// callouts the HUD names all come from this grid, so the server, the client
// and the bots read the same geometry.
//
//   #  wall (full height)        .  floor
//   c  low crate (see over it)   C  high crate (blocks sight)
//   A  A bomb site floor         B  B bomb site floor
//   t  T spawn floor             k  CT spawn floor
const ROWS = [
  "################################",
  "#........###........###........#",
  "#......C.###.kkkkkk.###.c......#",
  "#..BBBB......kkkkkk......AAAA..#",
  "#..BBBB..................ACAA..#",
  "#.cBBBB..###........###..AAAA..#",
  "#..BBBB..#####....#####..AAAA..#",
  "#......c.#####....#####......c.#",
  "#.....c..#####....#####........#",
  "##...##########..######........#",
  "##...##########..######..###...#",
  "##...#########....#####..###.c.#",
  "##...#########...........###...#",
  "##...#########.......c...###...#",
  "##................##########...#",
  "##................##########...#",
  "##...#########.c..##########...#",
  "##...#########....##########...#",
  "##.c.#########....##########...#",
  "##...#########....##########...#",
  "##...#########....########.....#",
  "##.............................#",
  "##.............................#",
  "#########.c..........c.#########",
  "#########...tttttttt...#########",
  "#########...tttttttt...#########",
  "#########..............#########",
  "################################",
];

/** Metres per cell. Corridors are two cells (5 m) wide. */
export const CELL = 2.5;
export const WALL_H = 3.6;
export const LOW_CRATE_H = 1.05;
export const HIGH_CRATE_H = 2.1;
const CRATE_INSET = 0.2;

export type Side = "T" | "CT";
export type SiteId = "A" | "B";

export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  kind: "wall" | "crate";
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Callout extends Rect {
  name: string;
}

export interface GameMap {
  name: string;
  cols: number;
  rows: number;
  /** metres */
  width: number;
  depth: number;
  rowsText: readonly string[];
  /** index into boxes per cell, -1 for open floor */
  cellBox: Int32Array;
  boxes: Box[];
  spawns: Record<Side, { x: number; z: number; yaw: number }[]>;
  sites: Record<SiteId, Rect & { cx: number; cz: number }>;
  buyZones: Record<Side, Rect>;
  callouts: Callout[];
}

/** A rectangle in cell coordinates (inclusive rows and columns) as metres. */
const cells = (r0: number, r1: number, c0: number, c1: number): Rect => ({ x0: c0 * CELL, z0: r0 * CELL, x1: (c1 + 1) * CELL, z1: (r1 + 1) * CELL });

function build(): GameMap {
  const rows = ROWS.length;
  const cols = ROWS[0].length;
  const cellBox = new Int32Array(rows * cols).fill(-1);
  const boxes: Box[] = [];
  const found: Record<string, [number, number][]> = {};
  for (let r = 0; r < rows; r++) {
    if (ROWS[r].length !== cols) throw new Error(`map row ${r} is ${ROWS[r].length} wide, expected ${cols}`);
    for (let c = 0; c < cols; c++) {
      const ch = ROWS[r][c];
      (found[ch] ??= []).push([r, c]);
      const x0 = c * CELL;
      const z0 = r * CELL;
      if (ch === "#") {
        cellBox[r * cols + c] = boxes.length;
        boxes.push({ x0, y0: 0, z0, x1: x0 + CELL, y1: WALL_H, z1: z0 + CELL, kind: "wall" });
      } else if (ch === "c" || ch === "C") {
        cellBox[r * cols + c] = boxes.length;
        const h = ch === "c" ? LOW_CRATE_H : HIGH_CRATE_H;
        boxes.push({ x0: x0 + CRATE_INSET, y0: 0, z0: z0 + CRATE_INSET, x1: x0 + CELL - CRATE_INSET, y1: h, z1: z0 + CELL - CRATE_INSET, kind: "crate" });
      }
    }
  }
  const bounds = (ch: string): Rect & { cx: number; cz: number } => {
    const list = found[ch] ?? [];
    const r0 = Math.min(...list.map(([r]) => r));
    const r1 = Math.max(...list.map(([r]) => r));
    const c0 = Math.min(...list.map(([, c]) => c));
    const c1 = Math.max(...list.map(([, c]) => c));
    const rect = cells(r0, r1, c0, c1);
    return { ...rect, cx: (rect.x0 + rect.x1) / 2, cz: (rect.z0 + rect.z1) / 2 };
  };
  // spawn points: every spawn cell's centre, ordered so the first five are spread out
  const spawnList = (ch: string, yaw: number): { x: number; z: number; yaw: number }[] => {
    const list = (found[ch] ?? []).map(([r, c]) => ({ x: (c + 0.5) * CELL, z: (r + 0.5) * CELL, yaw }));
    const spread: typeof list = [];
    const step = 3;
    for (let k = 0; k < step; k++) for (let i = k; i < list.length; i += step) spread.push(list[i]);
    return spread;
  };
  return {
    name: "Kiln",
    cols,
    rows,
    width: cols * CELL,
    depth: rows * CELL,
    rowsText: ROWS,
    cellBox,
    boxes,
    // yaw 0 faces north (-z): Ts look up the map towards the sites, CTs look down it
    spawns: { T: spawnList("t", 0), CT: spawnList("k", Math.PI) },
    sites: { A: bounds("A"), B: bounds("B") },
    buyZones: { T: cells(21, 26, 9, 22), CT: cells(1, 5, 12, 19) },
    // first match wins, so the narrow places come before the rooms they open into
    callouts: [
      { name: "B door", ...cells(3, 4, 9, 11) },
      { name: "A door", ...cells(3, 4, 20, 22) },
      { name: "CT spawn", ...cells(1, 5, 12, 19) },
      { name: "B site", ...cells(1, 8, 1, 8) },
      { name: "A site", ...cells(1, 9, 23, 30) },
      { name: "Mid doors", ...cells(6, 11, 14, 17) },
      { name: "Catwalk", ...cells(10, 13, 18, 24) },
      { name: "Mid", ...cells(12, 20, 14, 17) },
      { name: "A long", ...cells(10, 19, 28, 30) },
      { name: "Long doors", ...cells(20, 22, 22, 30) },
      { name: "Connector", ...cells(14, 15, 5, 13) },
      { name: "B tunnels", ...cells(9, 20, 1, 4) },
      { name: "Lower tunnels", ...cells(21, 22, 1, 8) },
      { name: "T spawn", ...cells(21, 26, 9, 21) },
    ],
  };
}

export const MAP: GameMap = build();

export const inRect = (r: Rect, x: number, z: number): boolean => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

export function calloutAt(x: number, z: number, map: GameMap = MAP): string {
  for (const c of map.callouts) if (inRect(c, x, z)) return c.name;
  return "";
}

export function siteAt(x: number, z: number, map: GameMap = MAP): SiteId | null {
  if (inRect(map.sites.A, x, z)) return "A";
  if (inRect(map.sites.B, x, z)) return "B";
  return null;
}

/** The box covering a cell, or null for open floor and anything off the map. */
export function boxAtCell(c: number, r: number, map: GameMap = MAP): Box | null {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return null;
  const i = map.cellBox[r * map.cols + c];
  return i < 0 ? null : map.boxes[i];
}

/** Cells a body can stand in: no wall, no crate, on the map. */
export function walkable(c: number, r: number, map: GameMap = MAP): boolean {
  return c >= 0 && r >= 0 && c < map.cols && r < map.rows && map.cellBox[r * map.cols + c] < 0;
}
