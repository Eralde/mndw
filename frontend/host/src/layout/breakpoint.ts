// px, intentionally NOT rem: this value is mirrored by the `@media (max-width: 720px)`
// query in styles/global.css. Media-query lengths resolve against the browser default
// font size, so JS (matchMedia) and CSS must share the same px threshold
export const MOBILE_BREAKPOINT_PX = 720;

export function mobileMediaQuery(): MediaQueryList {
  return window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)');
}
