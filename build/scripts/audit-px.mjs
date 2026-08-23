import {readdirSync, readFileSync, statSync} from 'node:fs';
import {relative, resolve} from 'node:path';

const DEFAULT_ROOTS = [
  'frontend/host/src',
  'frontend/ui/src',
  'plugins/builtin',
  'plugins/examples',
  'build/palette/playground',
  'tooling/cli/templates',
  'build/palette/src/scale.ts',
  'frontend/sdk/src/tokens.css',
];

const TEST_FILE = /(?:\.test|\.spec)\.[^/]+$/u;
const NUMERIC_PX = /(?<![A-Za-z0-9_])(?:\d+(?:\.\d+)?|\.\d+)px\b/gu;
const TEMPLATE_PX = /\$\{[^}]*\}px\b/gu;
const CONCAT_PX = /(['"])px\1/gu;

const normalize = (value) => value.replaceAll('\\', '/');

const repoPath = (file) => normalize(relative(process.cwd(), file));

const hasSuffix = (file, suffix) => file === suffix || file.endsWith(`/${suffix}`);

const collectFiles = (root) => {
  const absoluteRoot = resolve(root);
  if (!statSync(absoluteRoot).isDirectory()) {
    return [absoluteRoot];
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (entry.name === '.nocommit') {
        continue;
      }
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else {
        files.push(file);
      }
    }
  };
  visit(absoluteRoot);
  return files;
};

const isExcluded = (file) => {
  const normalized = repoPath(file);
  return normalized.split('/').includes('.nocommit') ||
    normalized.split('/').includes('dist') ||
    TEST_FILE.test(normalized) ||
    normalized.includes('/e2e/fixtures/');
};

export const stripComments = (source) => {
  let output = '';
  let quote = null;
  let escaped = false;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (quote !== null) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += character;
      index += 1;
      continue;
    }

    if (character === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          output += '  ';
          index += 2;
          break;
        }
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (source.startsWith('<!--', index)) {
      output += '    ';
      index += 4;
      while (index < source.length) {
        if (source.startsWith('-->', index)) {
          output += '   ';
          index += 3;
          break;
        }
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
};

const lineNumberAt = (source, index) => source.slice(0, index).split('\n').length;

const lineAt = (source, index) => {
  const start = source.lastIndexOf('\n', index - 1) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end).trim();
};

const declarationAt = (source, index) => {
  const start = Math.max(
    source.lastIndexOf(';', index - 1),
    source.lastIndexOf('{', index - 1),
    source.lastIndexOf('}', index - 1),
    source.lastIndexOf('\n', index - 1),
  ) + 1;
  const endCandidates = [source.indexOf(';', index), source.indexOf('}', index), source.indexOf('\n', index)]
    .filter((value) => value >= 0);
  const end = endCandidates.length === 0 ? source.length : Math.min(...endCandidates);
  const declaration = source.slice(start, end);
  const property = /(?:^|[\s{])([-_a-zA-Z][-_a-zA-Z0-9]*)\s*:/u.exec(declaration)?.[1]?.toLowerCase() ?? '';
  return {declaration, property};
};

const isInsideAtRule = (source, index) => {
  const prefix = source.slice(0, index);
  const matches = [...prefix.matchAll(/@(media|container)\b[^{}]*\{/gu)];
  if (matches.length === 0) {
    const line = lineAt(source, index);
    return /@(media|container)\b[^{}]*(?:min|max)-width\s*:/u.test(line) ||
      /@(media|container)\b[^{}]*(?:min|max)-width\s*\(/u.test(line);
  }
  const match = matches.at(-1);
  const openingBrace = source.indexOf('{', match.index);
  return match.index > prefix.lastIndexOf('}') && (openingBrace === -1 || index < openingBrace);
};

const isBorderWidth = (property) => property === 'border' ||
  property === 'outline' ||
  property === 'outline-width' ||
  property === 'borderwidth' ||
  property === 'outlinewidth' ||
  (property.startsWith('border-') && !property.includes('radius') && !property.endsWith('color'));

const isShadow = (property, declaration) => property === 'box-shadow' ||
  property === 'text-shadow' ||
  (property === 'filter' && declaration.includes('drop-shadow('));

const isTokenException = (file, line) => {
  if (hasSuffix(file, 'build/palette/src/scale.ts')) {
    return line.includes('border:') || line.includes('shadow1:') || line.includes('shadow2:');
  }
  if (hasSuffix(file, 'frontend/sdk/src/tokens.css')) {
    return /--mndw-(?:border-w|focus-w|shadow-1|shadow-2):/u.test(line);
  }
  return false;
};

const isScreenReaderClip = (file, property, line) =>
  hasSuffix(file, 'plugins/builtin/system-log-page/src/SystemLogPage.svelte') &&
  ((property === 'width' && line.includes('width: 1px')) ||
    (property === 'height' && line.includes('height: 1px')) ||
    (property === 'margin' && line.includes('margin: -1px')));

const isRuntimeGeometry = (file, declaration, line, occurrence) => {
  if (hasSuffix(file, 'frontend/ui/src/position/position.ts')) {
    return occurrence.startsWith('${') || declaration.includes('calc(') || declaration.includes('min(') || /\d(?:vw|vh|vmin|vmax)\b/u.test(declaration);
  }
  if (hasSuffix(file, 'frontend/ui/src/overlay.ts')) {
    return /contentElement\.style\.(?:left|top)/u.test(line);
  }
  if (hasSuffix(file, 'frontend/ui/src/select/select-popover.ts')) {
    return /style\.(?:minWidth|maxHeight|maxWidth)/u.test(line);
  }
  if (hasSuffix(file, 'frontend/ui/src/textarea/textarea.ts')) {
    return /style\.height/u.test(line);
  }
  if (hasSuffix(file, 'frontend/ui/src/scroll-area/scroll-area.ts')) {
    return /thumb\.style\.(?:height|transform)|translateY\(/u.test(line);
  }
  if (hasSuffix(file, 'frontend/ui/src/table/table.ts')) {
    return /style="height:|style\.height/u.test(line);
  }
  if (hasSuffix(file, 'frontend/ui/src/tooltip/tooltip.ts')) {
    return /bubble\.style\.(?:top|left)/u.test(line);
  }
  if (hasSuffix(file, 'frontend/ui/src/charts/bar-chart.ts') ||
      hasSuffix(file, 'frontend/ui/src/charts/line-chart.ts') ||
      hasSuffix(file, 'frontend/ui/src/charts/chart-frame.ts')) {
    return occurrence.includes('.left') || occurrence.includes('.top');
  }
  if (hasSuffix(file, 'frontend/host/src/components/overlay/OverlayHost.svelte')) {
    return /(?:top|left).*\$\{|\$\{.*(?:top|left)/u.test(declaration);
  }
  if (hasSuffix(file, 'frontend/host/src/layout/breakpoint.ts')) {
    return line.includes('MOBILE_BREAKPOINT_PX') || line.includes("'px'") || line.includes('"px"');
  }
  if (hasSuffix(file, 'plugins/builtin/device-info-widget/src/components/LoadBarChart.vue')) {
    return line.includes('tooltip.left');
  }
  return false;
};

export const classify = (file, source, index, occurrence) => {
  const {declaration, property} = declarationAt(source, index);
  const line = lineAt(source, index);
  if (isTokenException(file, line)) {
    return null;
  }
  if (isBorderWidth(property)) {
    return null;
  }
  if (/\b(?:borderWidth|outlineWidth)\s*=/u.test(line)) {
    return null;
  }
  if (isShadow(property, declaration)) {
    return null;
  }
  if (isInsideAtRule(source, index)) {
    return null;
  }
  if (/\d(?:vw|vh|vmin|vmax)\b/u.test(declaration)) {
    return null;
  }
  if (isScreenReaderClip(file, property, line)) {
    return null;
  }
  if (isRuntimeGeometry(file, declaration, line, occurrence)) {
    return null;
  }
  return `unclassified ${occurrence} in ${property || 'unknown declaration'}`;
};

export const occurrences = (source) => {
  const found = [];
  for (const expression of [NUMERIC_PX, TEMPLATE_PX, CONCAT_PX]) {
    expression.lastIndex = 0;
    for (const match of source.matchAll(expression)) {
      found.push({index: match.index, text: match[0]});
    }
  }
  return found.sort((left, right) => left.index - right.index).filter((entry, index, all) => index === 0 || entry.index !== all[index - 1].index);
};

export const auditPx = ({roots = DEFAULT_ROOTS} = {}) => {
  const violations = [];
  const files = roots.flatMap((root) => collectFiles(root));
  for (const file of files) {
    if (isExcluded(file)) {
      continue;
    }
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (source.includes('\0')) {
      continue;
    }
    const cleaned = stripComments(source);
    for (const {index, text} of occurrences(cleaned)) {
      const reason = classify(repoPath(file), cleaned, index, text);
      if (reason !== null) {
        violations.push({path: repoPath(file), line: lineNumberAt(cleaned, index), reason});
      }
    }
  }
  return {violations};
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = auditPx({roots: process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS});
  for (const violation of result.violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.reason}`);
  }
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}
