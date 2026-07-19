export const MOBILE_BREAKPOINT_PX = 720;

export function mobileMediaQuery(): MediaQueryList {
  return window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)');
}
