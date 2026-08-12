export const createInstance = (): {destroy(): void} => {
  return {destroy: () => {}};
};
