export interface Config { roomL: number; roomB: number; tileL: number; tileB: number }
export interface Pt { x: number; y: number }
export interface TileHit { row: number; col: number; id: string; zone: number }

export const gridSize = (c: Config) => ({ cols: Math.ceil(c.roomL / c.tileL), rows: Math.ceil(c.roomB / c.tileB) });

/**
 * Origin (0,0) is the bottom-left corner of the whole floor. X runs along the floor length, Y along its breadth. Units: mm.
 * Column = floor(X / tileL), Row = floor(Y / tileB). Zone ids are R<row>C<col>, counted from 1.
 * Zone 1 = R1C1, Zone 2 = R1C2, Zone 3 = R2C1, Zone 4 = R2C2 for the 2 x 2 floor.
 */
export function tileAt(c: Config, x: number, y: number): TileHit | null {
  if (x < 0 || y < 0 || x > c.roomL || y > c.roomB) return null;
  const { cols, rows } = gridSize(c);
  const col = Math.min(Math.floor(x / c.tileL), cols - 1);
  const row = Math.min(Math.floor(y / c.tileB), rows - 1);
  return { row, col, id: `R${row + 1}C${col + 1}`, zone: row * cols + col + 1 };
}
