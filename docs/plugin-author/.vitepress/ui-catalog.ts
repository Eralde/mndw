export interface UiCatalogEntry {
  readonly slug: string;
  readonly title: string;
  readonly sidebarTitle: string;
  readonly summary: string;
  readonly tags: readonly string[];
}

export const UI_CATALOG: readonly UiCatalogEntry[] = [
  {
    slug: 'button',
    title: '<mndw-button>',
    sidebarTitle: '&lt;mndw-button&gt;',
    summary: 'variant="primary", "secondary", "ghost", or "danger"; type="button", "submit", or "reset".',
    tags: ['mndw-button'],
  },
  {
    slug: 'icon',
    title: '<mndw-icon>',
    sidebarTitle: '&lt;mndw-icon&gt;',
    summary: 'Renders one Lucide symbol from the shared sprite; name and label; host supplies iconSpriteUrl.',
    tags: ['mndw-icon'],
  },
  {
    slug: 'checkbox',
    title: '<mndw-checkbox>',
    sidebarTitle: '&lt;mndw-checkbox&gt;',
    summary: 'Emits mndwchange; form-associated with name, value, required, and invalid.',
    tags: ['mndw-checkbox'],
  },
  {
    slug: 'switch',
    title: '<mndw-switch>',
    sidebarTitle: '&lt;mndw-switch&gt;',
    summary: 'role="switch" on the host; immediate-effect toggle. Emits mndwchange.',
    tags: ['mndw-switch'],
  },
  {
    slug: 'input',
    title: '<mndw-input>',
    sidebarTitle: '&lt;mndw-input&gt;',
    summary: 'Native inner <input> with delegated focus. Emits mndwinput and mndwchange.',
    tags: ['mndw-input'],
  },
  {
    slug: 'textarea',
    title: '<mndw-textarea>',
    sidebarTitle: '&lt;mndw-textarea&gt;',
    summary: 'Native inner <textarea>; rows sizing with opt-in autosize. Same events.',
    tags: ['mndw-textarea'],
  },
  {
    slug: 'field',
    title: '<mndw-field>',
    sidebarTitle: '&lt;mndw-field&gt;',
    summary: 'Light-DOM label/hint/error wrapper for a single control. Renders no shadow root.',
    tags: ['mndw-field'],
  },
  {
    slug: 'select',
    title: '<mndw-select>',
    sidebarTitle: '&lt;mndw-select&gt;',
    summary: 'Slotted <mndw-option> children. Emits mndwchange.',
    tags: ['mndw-select', 'mndw-option', 'mndw-select-panel'],
  },
  {
    slug: 'segmented',
    title: '<mndw-segmented>',
    sidebarTitle: '&lt;mndw-segmented&gt;',
    summary: 'role="radiogroup" with slotted <mndw-segment> children. Emits mndwchange.',
    tags: ['mndw-segmented', 'mndw-segment'],
  },
  {
    slug: 'slider',
    title: '<mndw-slider>',
    sidebarTitle: '&lt;mndw-slider&gt;',
    summary: 'role="slider" on the host; numeric range with pointer drag. Emits mndwinput and mndwchange.',
    tags: ['mndw-slider'],
  },
  {
    slug: 'tabs',
    title: '<mndw-tabs>',
    sidebarTitle: '&lt;mndw-tabs&gt;',
    summary: 'Container owning an internal tablist, the active value, and its children\'s ARIA. Emits mndwchange.',
    tags: ['mndw-tabs', 'mndw-tab', 'mndw-tab-panel'],
  },
  {
    slug: 'tooltip',
    title: '<mndw-tooltip>',
    sidebarTitle: '&lt;mndw-tooltip&gt;',
    summary: 'Describes its first slotted element on hover and focus. Not form-associated.',
    tags: ['mndw-tooltip'],
  },
  {
    slug: 'scroll-area',
    title: '<mndw-scroll-area>',
    sidebarTitle: '&lt;mndw-scroll-area&gt;',
    summary: 'Native viewport with an always-visible bespoke scrollbar when content overflows.',
    tags: ['mndw-scroll-area'],
  },
  {
    slug: 'table',
    title: '<mndw-table>',
    sidebarTitle: '&lt;mndw-table&gt;',
    summary: 'Framework-neutral data table; columns/rows as properties, controlled sort/selection/visibility, custom light-DOM cell renderers.',
    tags: ['mndw-table', 'mndw-column-menu'],
  },
  {
    slug: 'line-chart',
    title: '<mndw-line-chart>',
    sidebarTitle: '&lt;mndw-line-chart&gt;',
    summary: 'Timestamped multi-series line/area chart; data is assigned through properties.',
    tags: ['mndw-line-chart'],
  },
  {
    slug: 'bar-chart',
    title: '<mndw-bar-chart>',
    sidebarTitle: '&lt;mndw-bar-chart&gt;',
    summary: 'Timestamped positional bar chart; data is assigned through properties.',
    tags: ['mndw-bar-chart'],
  },
  {
    slug: 'sparkline',
    title: '<mndw-sparkline>',
    sidebarTitle: '&lt;mndw-sparkline&gt;',
    summary: 'Compact percentage bar chart; data is assigned through points.',
    tags: ['mndw-sparkline'],
  },
  {
    slug: 'heat-strip',
    title: '<mndw-heat-strip>',
    sidebarTitle: '&lt;mndw-heat-strip&gt;',
    summary: 'Compact utilization heat strip; data is assigned through points.',
    tags: ['mndw-heat-strip'],
  },
  {
    slug: 'css-classes',
    title: 'CSS classes',
    sidebarTitle: 'CSS classes',
    summary: 'Global layout, status, form, and table styles for consistent pages.',
    tags: [],
  },
];
