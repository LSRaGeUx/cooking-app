import { KeyboardCode, type KeyboardCoordinateGetter } from "@dnd-kit/core";

/**
 * Arrow keys that move a meal from slot to slot, not 25 pixels at a time.
 *
 * dnd-kit's default keyboard getter nudges the drag position by a fixed number
 * of pixels, which is fine for a list and useless for this grid: a Monday
 * dinner is several hundred pixels from a Tuesday dinner, so the default turns
 * one move into a dozen key presses with no idea where the meal will land.
 *
 * This one treats the droppables as what they are, a grid of cells, and jumps
 * to the nearest one in the direction pressed. "Nearest" is measured with the
 * sideways distance weighted heavily, so pressing down within a day walks
 * through that day's meals rather than sliding into the next column.
 */

const DIRECTIONS: string[] = [
  KeyboardCode.Down,
  KeyboardCode.Right,
  KeyboardCode.Up,
  KeyboardCode.Left,
];

/** How much harder it is to drift sideways than to move in the direction asked. */
const OFF_AXIS_WEIGHT = 4;

export const gridKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { active, droppableRects, droppableContainers, collisionRect } },
) => {
  if (!DIRECTIONS.includes(event.code)) return undefined;
  if (!collisionRect) return undefined;

  event.preventDefault();

  const from = centreOf(collisionRect);
  let best: { id: string; centre: Point; cost: number } | null = null;

  for (const container of droppableContainers.getEnabled()) {
    // A meal cannot be dropped onto itself.
    if (container.id === active?.id) continue;

    const rect = droppableRects.get(container.id);
    if (!rect) continue;

    const centre = centreOf(rect);
    const dx = centre.x - from.x;
    const dy = centre.y - from.y;

    const along = alongAxis(event.code, dx, dy);
    // Only cells genuinely in the direction pressed. The tolerance keeps a cell
    // whose centre sits a pixel off from being skipped.
    if (along <= 1) continue;

    const across = acrossAxis(event.code, dx, dy);
    const cost = along + Math.abs(across) * OFF_AXIS_WEIGHT;

    if (best === null || cost < best.cost) {
      best = { id: String(container.id), centre, cost };
    }
  }

  if (best === null) return undefined;

  // dnd-kit wants the new position of the dragged item's top left corner, so
  // the target centre is turned back into an offset.
  return {
    x: best.centre.x - collisionRect.width / 2,
    y: best.centre.y - collisionRect.height / 2,
  };
};

interface Point {
  readonly x: number;
  readonly y: number;
}

function centreOf(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function alongAxis(code: string, dx: number, dy: number): number {
  switch (code) {
    case KeyboardCode.Down:
      return dy;
    case KeyboardCode.Up:
      return -dy;
    case KeyboardCode.Right:
      return dx;
    default:
      return -dx;
  }
}

function acrossAxis(code: string, dx: number, dy: number): number {
  return code === KeyboardCode.Down || code === KeyboardCode.Up ? dx : dy;
}
