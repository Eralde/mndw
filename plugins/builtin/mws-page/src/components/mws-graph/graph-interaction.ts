export interface GraphPoint {
  x: number;
  y: number;
}

export function dragPosition(origin: GraphPoint, pointer: GraphPoint, pointerOrigin: GraphPoint): GraphPoint {
  return {
    x: origin.x + pointer.x - pointerOrigin.x,
    y: origin.y + pointer.y - pointerOrigin.y,
  };
}

export function isClickWithinSlop(origin: GraphPoint, current: GraphPoint, slop: number): boolean {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;

  return Math.sqrt(dx * dx + dy * dy) < slop;
}
