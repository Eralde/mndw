import '@mndw/sdk/tokens.css';
import {defineMndwUi} from '@mndw/ui';
// The class layer, imported rather than restated: the preview must judge the palette against the
// same rules consumers get.
import '@mndw/ui/styles.css';
import {PALETTE_CSS_VARIABLES} from '@mndw/sdk/palette';
import {SEED, type Seed, type ThemeName, type TokenName, buildPalette, validatePalette} from '../src/index.js';

defineMndwUi();

const themeSelect = document.getElementById('theme') as HTMLSelectElement;
const swatchesEl = document.getElementById('swatches') as HTMLElement;
const gridEl = document.getElementById('grid') as HTMLTableElement;
const verdictEl = document.getElementById('verdict') as HTMLElement;
const inPrimary = document.getElementById('in-primary') as HTMLInputElement;
const inDanger = document.getElementById('in-danger') as HTMLInputElement;
const inBg = document.getElementById('in-bg') as HTMLInputElement;
const inText = document.getElementById('in-text') as HTMLInputElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;

interface Pane {
  theme: ThemeName;
  el: HTMLElement;
}

const PANES: Pane[] = [
  {theme: 'light', el: document.getElementById('preview-light') as HTMLElement},
  {theme: 'dark', el: document.getElementById('preview-dark') as HTMLElement},
];

// Mutable working copy of the seed; HEX inputs edit it live.
let seed: Seed = structuredClone(SEED);

/**
 * The whole shipped surface, so a palette candidate is judged against real components rather than
 * an approximation of them. Ids are prefixed because both panes render this at once and the
 * tab/panel pairing resolves by id.
 */
function gallery(prefix: string): string {
  return `
    <div class="gallery">
      <p class="gallery__heading">Text family — native element inside, host owns the form value</p>
      <div class="gallery__group">
        <mndw-field label="Host name" hint="Shown in the device list.">
          <mndw-input value="keenetic"></mndw-input>
        </mndw-field>
        <mndw-field label="Listen port" hint="1–65535" required>
          <mndw-input type="number" min="1" max="65535" step="1" value="8080"></mndw-input>
        </mndw-field>
        <mndw-field label="API token" error="That token is not valid.">
          <mndw-input type="password" value="hunter2"></mndw-input>
        </mndw-field>
        <mndw-field label="Release notes" hint="Markdown is supported.">
          <mndw-textarea rows="2"></mndw-textarea>
        </mndw-field>
      </div>

      <p class="gallery__heading">Semantic family — role and state on the host</p>
      <div class="gallery__group">
        <mndw-checkbox checked>Show offline devices</mndw-checkbox>
        <mndw-checkbox indeterminate>Some interfaces</mndw-checkbox>
        <mndw-checkbox disabled>Unavailable</mndw-checkbox>
      </div>
      <div class="gallery__group">
        <mndw-field label="Dark theme">
          <mndw-switch checked></mndw-switch>
        </mndw-field>
        <mndw-select placeholder="Interface…" label="Interface" style="width: 13.75rem">
          <mndw-option value="isp">Wired</mndw-option>
          <mndw-option value="wifi">Wireless</mndw-option>
          <mndw-option value="lte" disabled>LTE (unavailable)</mndw-option>
        </mndw-select>
        <mndw-segmented label="Range" value="day">
          <mndw-segment value="day">Day</mndw-segment>
          <mndw-segment value="week">Week</mndw-segment>
          <mndw-segment value="month" disabled>Month</mndw-segment>
        </mndw-segmented>
      </div>
      <mndw-field label="Transmit power">
        <mndw-slider min="0" max="20" step="5" value="10" value-text="10 dBm"></mndw-slider>
      </mndw-field>

      <p class="gallery__heading">Native-delegating — a real button inside the shadow root</p>
      <div class="gallery__group">
        <mndw-button variant="primary">Apply</mndw-button>
        <mndw-button variant="secondary">Cancel</mndw-button>
        <mndw-button variant="ghost" aria-label="Settings"><mndw-icon name="settings"></mndw-icon></mndw-button>
        <mndw-button variant="danger">Delete plugin</mndw-button>
        <mndw-button variant="primary" disabled>Applying…</mndw-button>
        <mndw-tooltip text="Restarts the device immediately" delay="120">
          <mndw-button variant="danger">Restart</mndw-button>
        </mndw-tooltip>
      </div>

      <p class="gallery__heading">Tabs</p>
      <mndw-tabs value="${prefix}-status">
        <mndw-tab id="${prefix}-status">Status</mndw-tab>
        <mndw-tab id="${prefix}-clients">Clients</mndw-tab>
        <mndw-tab id="${prefix}-logs" disabled>Logs</mndw-tab>
        <mndw-tab-panel for="${prefix}-status">Uplink is connected.</mndw-tab-panel>
        <mndw-tab-panel for="${prefix}-clients">12 devices online.</mndw-tab-panel>
      </mndw-tabs>

      <p class="gallery__heading">Class layer</p>
      <div class="mndw-alert mndw-alert--danger" role="alert">
        <div class="mndw-alert__title">Connection failed</div>
        <div class="mndw-alert__body">Retry the request or check the uplink.</div>
      </div>
      <div class="gallery__group">
        <div class="mndw-alert mndw-alert--success">Firmware is current</div>
        <div class="mndw-alert mndw-alert--warning">Reboot pending</div>
        <div class="mndw-alert mndw-alert--info">Scan in progress</div>
      </div>
      <div class="gallery__group">
        <span class="mndw-badge">Neutral</span>
        <span class="mndw-badge mndw-badge--danger">Offline</span>
        <span class="mndw-badge mndw-badge--success">Connected</span>
        <span class="mndw-badge mndw-badge--warning">Degraded</span>
        <span class="mndw-badge mndw-badge--info">Scanning</span>
        <span class="mndw-status-dot mndw-status-dot--success" aria-hidden="true"></span>
        <span class="mndw-status-dot mndw-status-dot--danger" aria-hidden="true"></span>
        <span class="mndw-spinner" aria-hidden="true"></span>
      </div>
      <div class="mndw-progress" role="progressbar" aria-busy="true"></div>
      <div class="mndw-toolbar">
        <span class="mndw-badge mndw-badge--info">3 selected</span>
        <mndw-button variant="secondary">Update</mndw-button>
      </div>
      <div class="mndw-card">
        <table class="mndw-table mndw-table--sticky-head">
          <caption>Connected clients</caption>
          <thead>
            <tr><th aria-sort="ascending">Name</th><th>Address</th><th>Link</th></tr>
          </thead>
          <tbody>
            <tr><td>living-room-tv</td><td>192.168.1.24</td><td>Wi-Fi 6</td></tr>
            <tr><td>nas</td><td>192.168.1.10</td><td>1 Gbps</td></tr>
          </tbody>
        </table>
      </div>
      <div class="mndw-empty">No plugins installed yet.</div>
    </div>`;
}

function syncInputs(theme: ThemeName): void {
  inPrimary.value = seed.primary;
  inDanger.value = seed.danger;
  inBg.value = seed.bg[theme];
  inText.value = seed.text[theme];
}

function render(): void {
  const theme = themeSelect.value as ThemeName;

  syncInputs(theme);

  const palette = buildPalette(theme, seed);
  const results = validatePalette(palette);

  swatchesEl.innerHTML = '';

  for (const [name, hex] of Object.entries(palette) as [TokenName, string][]) {
    const div = document.createElement('div');

    div.className = 'swatch';
    div.style.background = hex;
    div.style.color = theme === 'dark' ? '#fff' : '#000';
    div.style.whiteSpace = 'pre';
    div.textContent = `${name}\n${hex}`;
    swatchesEl.appendChild(div);
  }

  gridEl.innerHTML = '<tr><th>pair</th><th>ratio</th><th>min</th><th>result</th></tr>';

  for (const r of results) {
    const tr = document.createElement('tr');

    tr.innerHTML = `<td>${r.pair}</td><td>${r.ratio}</td><td>${r.min}</td>`
      + `<td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</td>`;
    gridEl.appendChild(tr);
  }

  const allPass = results.every((r) => r.pass);

  verdictEl.textContent = allPass ? '✅ all pairs pass' : '❌ contrast failures';
  verdictEl.className = allPass ? 'pass' : 'fail';

  // Both panes repaint on every edit, so a candidate is always judged in light and dark at once.
  for (const pane of PANES) {
    paintPane(pane, buildPalette(pane.theme, seed));
  }
}

/**
 * Writes the candidate palette onto the pane as inline custom properties. They inherit into every
 * component's shadow DOM, so no `:root` mutation is involved and the playground's own chrome is
 * unaffected. The non-colour scale comes from the globally imported `tokens.css` at `:root` and
 * inherits the same way, which is why only the palette variables are set here.
 */
function paintPane(pane: Pane, palette: Record<TokenName, string>): void {
  for (const {token, cssVar} of PALETTE_CSS_VARIABLES) {
    pane.el.style.setProperty(cssVar, palette[token]);
  }

  pane.el.style.background = palette.bg;
  pane.el.style.color = palette.text;
  pane.el.style.border = `0.0625rem solid ${palette.border}`;
}

function onInput(): void {
  const theme = themeSelect.value as ThemeName;

  seed.primary = inPrimary.value;
  seed.danger = inDanger.value;
  seed.bg[theme] = inBg.value;
  seed.text[theme] = inText.value;
  render();
}

themeSelect.addEventListener('change', render);
for (const el of [inPrimary, inDanger, inBg, inText]) {
  el.addEventListener('input', onInput);
}

resetBtn.addEventListener('click', () => {
  seed = structuredClone(SEED);
  render();
});

// Built once, not per render: repainting the markup on every colour tweak would throw away the
// interaction state a reviewer is looking at — the open tab, the focused field, the dragged slider.
for (const pane of PANES) {
  pane.el.insertAdjacentHTML('beforeend', gallery(pane.theme));
}

render();
