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
  heatStrip: {height: string};
  table: {stickyTop: string};
  /**
   * Fixed utilization heatmap scale (theme-agnostic), low -> critical.
   * Low values use "colder" colors, high values use "hotter" colors.
   */
  utilization: {low: string; moderate: string; elevated: string; high: string; critical: string};
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
  text: {xs: '0.6875rem', sm: '0.8125rem', md: '0.875rem', lg: '1rem'},
  leading: '1.4',
  weight: {normal: '400', semibold: '600'},
  space: {1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 4: '1rem', 5: '1.5rem', 6: '2rem'},
  radius: {sm: '0.1875rem', md: '0.375rem', lg: '0.5rem'},
  control: {base: '2rem', sm: '1.75rem', lg: '2.5rem'},
  border: {width: '1px', focusWidth: '2px'},
  motion: {fast: '120ms', base: '180ms', easing: 'ease'},
  scrollbar: {size: '0.625rem', radius: '0.375rem', thumbMinSize: '1.5rem'},
  switch: {width: '2.25rem', height: '1.25rem'},
  slider: {trackHeight: '0.25rem', thumbSize: '1rem'},
  heatStrip: {height: '1rem'},
  table: {stickyTop: '0'},
  utilization: {
    low: '#3fa89f',
    moderate: '#7cc24b',
    elevated: '#e6c229',
    high: '#e8873a',
    critical: '#d5432f',
  },
  aliases: {
    scrollbarTrack: 'var(--mndw-surface)',
    scrollbarThumb: 'var(--mndw-accent)',
    scrollbarThumbHover: 'var(--mndw-accent-hover)',
    shadow1: '0 1px 2px var(--mndw-shadow-color)',
    shadow2: '0 8px 24px var(--mndw-shadow-color)',
  },
};
