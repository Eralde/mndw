import {fetchWithDeadline} from './pristine-fetch.js';

const CSRF_HEADERS = {'X-Mndw-Csrf': '1'};
const MAX_FAILURE_TEXT = 4096;

const ENDPOINTS = [
  {title: 'mndwd diagnostics', path: '/api/mndw/diagnostics'},
  {title: 'persistent rci-session capability', path: '/api/mndw/rci-session/capability'},
  {title: 'extender access permission', path: '/api/mndw/extender-access'},
] as const;

const SENSITIVE_VALUE_PATTERNS = [
  /(["']?(?:password|passwd|token|secret|authorization|cookie|x-ndma-tkn)["']?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi,
  /(\b(?:password|passwd|token|secret|authorization|cookie|x-ndma-tkn)\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
];

export type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DiagnosticsSection {
  title: string;
  value?: unknown;
  error?: string;
}

export interface DownloadBrowser {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): HTMLAnchorElement;
  appendAnchor(anchor: HTMLAnchorElement): void;
  removeAnchor(anchor: HTMLAnchorElement): void;
}

export interface DiagnosticsDependencies {
  request: RequestFn;
  now: () => Date;
  browser: DownloadBrowser;
}

const defaultBrowser: DownloadBrowser = {
  createObjectURL: (blob) => {
    return globalThis.URL.createObjectURL(blob);
  },
  revokeObjectURL: (url) => {
    globalThis.URL.revokeObjectURL(url);
  },
  createAnchor: () => {
    return document.createElement('a');
  },
  appendAnchor: (anchor) => {
    document.body.appendChild(anchor);
  },
  removeAnchor: (anchor) => {
    anchor.remove();
  },
};

const defaultDependencies: DiagnosticsDependencies = {
  request: fetchWithDeadline,
  now: () => new Date(),
  browser: defaultBrowser,
};

/** Collects diagnostics and downloads one redacted plaintext report. */
export async function downloadDiagnostics(
  dependencies: DiagnosticsDependencies = defaultDependencies,
): Promise<void> {
  const settled = await Promise.allSettled(
    ENDPOINTS.map(async (endpoint) => {
      return await readJSON(await dependencies.request(endpoint.path, {headers: CSRF_HEADERS}));
    }),
  );
  const sections: DiagnosticsSection[] = settled.map((result, index) => {
    const endpoint = ENDPOINTS[index];

    if (result.status === 'fulfilled') {
      return {title: endpoint.title, value: result.value};
    }

    return {title: endpoint.title, error: errorMessage(result.reason)};
  });

  const generatedAt = dependencies.now();
  const report = formatDiagnosticsReport(sections, generatedAt);
  const blob = new Blob([report], {type: 'text/plain;charset=utf-8'});
  const objectURL = dependencies.browser.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  let appended = false;

  try {
    anchor = dependencies.browser.createAnchor();
    anchor.href = objectURL;
    anchor.download = `mndw-diagnostics-${formatFilenameTimestamp(generatedAt)}.txt`;
    anchor.hidden = true;
    dependencies.browser.appendAnchor(anchor);
    appended = true;
    anchor.click();
  } finally {
    if (anchor !== undefined && appended) {
      dependencies.browser.removeAnchor(anchor);
    }

    dependencies.browser.revokeObjectURL(objectURL);
  }
}

/** Formats report sections deterministically for tests and support tooling. */
export function formatDiagnosticsReport(
  sections: readonly DiagnosticsSection[],
  generatedAt: Date,
): string {
  const lines = ['MNDW diagnostics', `Generated at: ${generatedAt.toISOString()}`, ''];

  for (const section of sections) {
    lines.push(`## ${section.title}`);

    if (section.error !== undefined) {
      lines.push(`request failed: ${limitText(section.error)}`);
    } else {
      const formatted = JSON.stringify(section.value, null, 2);

      lines.push(formatted === undefined ? 'undefined' : formatted);
    }

    lines.push('');
  }

  return redact(lines.join('\n'));
}

async function readJSON(response: Response): Promise<unknown> {
  if (!response.ok) {
    let detail = '';

    try {
      detail = limitText(await response.text());
    } catch {
      detail = '';
    }

    throw new Error(`HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
  }

  return await response.json();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return limitText(error.message);
  }

  return limitText(String(error));
}

function limitText(value: string): string {
  return value.length > MAX_FAILURE_TEXT ? `${value.slice(0, MAX_FAILURE_TEXT)}…` : value;
}

function redact(value: string): string {
  let redacted = value;

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, '$1[REDACTED]');
  }

  return redacted;
}

function formatFilenameTimestamp(date: Date): string {
  const pad = (value: number): string => {
    return String(value).padStart(2, '0');
  };

  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
