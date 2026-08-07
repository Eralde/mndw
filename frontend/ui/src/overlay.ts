export type UiCloseReason = 'escape' | 'outside' | 'api' | 'detached';

export type UiLayerPresentation = 'popover' | 'sheet';

export interface UiLayerOptions {
  anchor: HTMLElement;
  presentation?: UiLayerPresentation;
  title?: string;
  className?: string;
}

export interface UiLayer {
  readonly contentElement: HTMLElement;
  readonly closed: Promise<UiCloseReason>;
  close(): void;
  reposition(): void;
}

export interface UiOverlayProvider {
  open(options: UiLayerOptions): UiLayer;
}

const GAP = 4;
const VIEWPORT_PADDING = 8;

export function createFallbackProvider(): UiOverlayProvider {
  return {
    open(options: UiLayerOptions): UiLayer {
      if (options.presentation === 'sheet') {
        return createFallbackSheet(options);
      }

      const contentElement = document.createElement('div');

      contentElement.className = options.className ?? '';
      contentElement.style.position = 'fixed';
      contentElement.style.zIndex = '1000';
      contentElement.style.visibility = 'hidden';
      document.body.appendChild(contentElement);

      let settle = (_reason: UiCloseReason): void => {};
      const closed = new Promise<UiCloseReason>((resolve) => {
        settle = resolve;
      });
      let isClosed = false;

      const close = (reason: UiCloseReason = 'api'): void => {
        if (isClosed) {
          return;
        }

        isClosed = true;
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
        contentElement.remove();
        settle(reason);
      };

      function onPointerDown(event: Event): void {
        const path = event.composedPath();

        if (path.includes(contentElement) || path.includes(options.anchor)) {
          return;
        }

        close('outside');
      }

      function onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
          close('escape');
        }
      }

      function position(): void {
        if (isClosed) {
          return;
        }

        const rect = options.anchor.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const height = contentElement.offsetHeight;
        const width = contentElement.offsetWidth;
        const below = viewportHeight - rect.bottom - GAP - VIEWPORT_PADDING;
        const above = rect.top - GAP - VIEWPORT_PADDING;
        const flip = below < height && above > below;

        contentElement.style.left = `${
          Math.min(
            Math.max(rect.left, VIEWPORT_PADDING),
            Math.max(viewportWidth - width - VIEWPORT_PADDING, VIEWPORT_PADDING),
          )
        }px`;
        contentElement.style.top = flip ? `${rect.top - GAP - height}px` : `${rect.bottom + GAP}px`;
        contentElement.style.visibility = 'visible';
      }

      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);

      return {
        contentElement,
        closed,
        close: () => {
          close('api');
        },
        reposition: position,
      };
    },
  };
}

function createFallbackSheet(options: UiLayerOptions): UiLayer {
  const root = document.createElement('div');

  root.className = ['mndw-ui-sheet-root', options.className].filter(Boolean).join(' ');
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.zIndex = '1000';
  root.style.display = 'flex';
  root.style.flexDirection = 'column';
  root.style.justifyContent = 'flex-end';

  const backdrop = document.createElement('div');

  backdrop.className = 'mndw-ui-sheet__backdrop';
  backdrop.style.position = 'absolute';
  backdrop.style.inset = '0';

  const surface = document.createElement('div');

  surface.className = 'mndw-ui-sheet';
  surface.setAttribute('role', 'dialog');
  surface.style.position = 'relative';
  surface.style.display = 'flex';
  surface.style.flexDirection = 'column';
  surface.style.width = '100%';
  surface.style.height = 'auto';
  surface.style.maxHeight = '100dvh';
  surface.style.minHeight = '0';

  const header = document.createElement('header');

  header.className = 'mndw-ui-sheet__header';
  header.style.display = 'flex';
  header.style.flexShrink = '0';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';

  const title = document.createElement('span');

  title.textContent = options.title ?? 'Select option';

  const closeButton = document.createElement('button');

  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';

  const body = document.createElement('div');

  body.className = 'mndw-ui-sheet__body';
  body.style.flex = '0 1 auto';
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.minHeight = '0';
  body.style.overflow = 'hidden';

  const contentElement = document.createElement('div');

  contentElement.style.display = 'flex';
  contentElement.style.flex = '1 1 auto';
  contentElement.style.flexDirection = 'column';
  contentElement.style.minHeight = '0';
  contentElement.style.overflow = 'hidden';

  let settle = (_reason: UiCloseReason): void => {};
  const closed = new Promise<UiCloseReason>((resolve) => {
    settle = resolve;
  });
  let isClosed = false;

  const close = (reason: UiCloseReason = 'api'): void => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    closeButton.removeEventListener('click', onCloseButtonClick);
    root.remove();
    settle(reason);
  };

  function onPointerDown(event: Event): void {
    const path = event.composedPath();

    if (path.includes(surface)) {
      return;
    }

    close('outside');
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      close('escape');
    }
  }

  function onCloseButtonClick(): void {
    close('api');
  }

  body.appendChild(contentElement);
  header.append(title, closeButton);
  surface.append(header, body);
  root.append(backdrop, surface);
  document.body.appendChild(root);

  closeButton.addEventListener('click', onCloseButtonClick);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);

  return {
    contentElement,
    closed,
    close: () => {
      close('api');
    },
    reposition: () => {},
  };
}

let injected: UiOverlayProvider | undefined;
let fallback: UiOverlayProvider | undefined;

export function setOverlayProvider(provider: UiOverlayProvider | undefined): void {
  injected = provider;
}

export function getOverlayProvider(): UiOverlayProvider {
  if (injected) {
    return injected;
  }

  fallback ??= createFallbackProvider();

  return fallback;
}
