import '@mndw/sdk/tokens.css';
import '../../src/styles/kit.css';
import iconSpriteUrl from '../../src/icon/generated/sprite.svg?url&no-inline';
import {defineMndwUi} from '../../src/index';

defineMndwUi({iconSpriteUrl});

document.documentElement.dataset.ready = 'true';
