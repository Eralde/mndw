import MarkdownIt from 'markdown-it';
import {describe, expect, it} from 'vitest';

import {uiDemoFence} from '../../docs/plugin-author/.vitepress/ui-demo-fence.js';

describe('UI demo fence renderer', () => {
  it('passes demo markup as data so Vue does not create or interpolate custom elements', () => {
    const demo = '<mndw-button data-value="20">{{ label }}</mndw-button>\n';
    const markdown = new MarkdownIt();

    uiDemoFence(markdown);

    const rendered = markdown.render(`\`\`\`html demo\n${demo}\`\`\`\n`);

    expect(rendered).toContain(`<UiHtmlDemo encoded-html="${encodeURIComponent(demo)}" />`);
    expect(rendered).not.toContain('<mndw-button');
    expect(rendered.match(/\{\{ label \}\}/gu)).toHaveLength(1);
    expect(rendered).toContain('&lt;mndw-button data-value=&quot;20&quot;&gt;{{ label }}&lt;/mndw-button&gt;');
  });
});
