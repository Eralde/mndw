export interface GraphGeometry {
  width: number;
  height: number;
}

export function stubGraphGeometry(element: Element, geometry: GraphGeometry): void {
  Object.defineProperties(element, {
    clientWidth: {configurable: true, value: geometry.width},
    clientHeight: {configurable: true, value: geometry.height},
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: geometry.height,
        height: geometry.height,
        left: 0,
        right: geometry.width,
        top: 0,
        width: geometry.width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    },
  });
}
