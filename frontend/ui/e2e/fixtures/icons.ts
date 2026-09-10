import '@mndw/sdk/tokens.css';
import '../../src/styles/kit.css';
import iconSpriteUrl from '../../src/icon/generated/sprite.svg?url&no-inline';
import {MNDW_ICON_NAMES, defineMndwUi} from '../../src/index';

defineMndwUi({iconSpriteUrl});

const gallery = document.querySelector<HTMLElement>('#icon-gallery');

if (!gallery) {
  throw new Error('icon gallery missing');
}

for (const theme of ['light', 'dark'] as const) {
  const section = document.createElement('div');

  section.className = `gallery gallery-${theme}`;
  section.dataset.theme = theme;

  for (const name of MNDW_ICON_NAMES) {
    const cell = document.createElement('span');
    const icon = document.createElement('mndw-icon');

    cell.className = 'gallery-cell';
    icon.setAttribute('name', name);
    cell.append(icon);
    section.append(cell);
  }

  gallery.append(section);
}

document.documentElement.dataset.ready = 'true';
