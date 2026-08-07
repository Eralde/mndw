export interface TokenScale {
  font: {sans: string; mono: string};
  text: Record<'xs' | 'sm' | 'md' | 'lg', string>;
  leading: string;
  weight: {normal: string; semibold: string};
  space: Record<1 | 2 | 3 | 4 | 5 | 6, string>;
  radius: Record<'sm' | 'md' | 'lg', string>;
  control: {base: string; sm: string; lg: string};
  border: {width: string; focusWidth: string};
  motion: {fast: string; base: string; easing: string};
  scrollbar: {size: string; radius: string; thumbMinSize: string};
  switch: {width: string; height: string};
  slider: {trackHeight: string; thumbSize: string};
  table: {stickyTop: string};
  aliases: {
    scrollbarTrack: string;
    scrollbarThumb: string;
    scrollbarThumbHover: string;
    shadow1: string;
    shadow2: string;
  };
}

export const SCALE: TokenScale = {
  font: {
    sans: '-apple-system, \'BlinkMacSystemFont\', \'Segoe UI\', \'Roboto\', sans-serif',
    mono: 'ui-monospace, \'SF Mono\', \'Menlo\', monospace',
  },
  text: {xs: '11px', sm: '13px', md: '14px', lg: '16px'},
  leading: '1.4',
  weight: {normal: '400', semibold: '600'},
  space: {1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px'},
  radius: {sm: '3px', md: '6px', lg: '8px'},
  control: {base: '32px', sm: '28px', lg: '40px'},
  border: {width: '1px', focusWidth: '2px'},
  motion: {fast: '120ms', base: '180ms', easing: 'ease'},
  scrollbar: {size: '10px', radius: '6px', thumbMinSize: '24px'},
  switch: {width: '36px', height: '20px'},
  slider: {trackHeight: '4px', thumbSize: '16px'},
  table: {stickyTop: '0px'},
  aliases: {
    scrollbarTrack: 'var(--mndw-surface)',
    scrollbarThumb: 'var(--mndw-accent)',
    scrollbarThumbHover: 'var(--mndw-accent-hover)',
    shadow1: '0 1px 2px var(--mndw-shadow-color)',
    shadow2: '0 8px 24px var(--mndw-shadow-color)',
  },
};
