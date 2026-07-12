import {
  SEED,
  type Seed,
  type ThemeName,
  type TokenName,
  buildPalette,
  validatePalette,
} from '../src/index.js';

const themeSelect = document.getElementById('theme') as HTMLSelectElement;
const swatchesEl = document.getElementById('swatches') as HTMLElement;
const gridEl = document.getElementById('grid') as HTMLTableElement;
const verdictEl = document.getElementById('verdict') as HTMLElement;
const previewEl = document.getElementById('preview') as HTMLElement;
const inPrimary = document.getElementById('in-primary') as HTMLInputElement;
const inDanger = document.getElementById('in-danger') as HTMLInputElement;
const inBg = document.getElementById('in-bg') as HTMLInputElement;
const inText = document.getElementById('in-text') as HTMLInputElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;

// Mutable working copy of the seed; HEX inputs edit it live.
let seed: Seed = structuredClone(SEED);

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

  previewEl.style.background = palette.surface;
  previewEl.style.color = palette.text;
  previewEl.style.border = `1px solid ${palette.border}`;
  previewEl.innerHTML = `<div style="color:${palette.text}">Body text</div>`
    + `<div style="color:${palette.textMuted}">Muted label</div>`
    + `<div style="color:${palette.textSubtle}">Subtle caption</div>`
    + `<button style="background:${palette.accent};color:${palette.accentContrast};`
    + `border:none;padding:6px 12px;border-radius:6px;margin-top:8px">Accent button</button>`
    + `<div style="background:${palette.dangerBg};color:${palette.danger};padding:6px;`
    + `border-radius:4px;margin-top:8px">Error message</div>`
    + `<div style="color:${palette.success};padding:6px 0">✓ Success message</div>`
    + `<div style="color:${palette.warning};padding:6px 0">⚠ Warning message</div>`;
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

render();
