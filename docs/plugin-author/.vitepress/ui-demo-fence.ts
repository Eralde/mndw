import type MarkdownIt from 'markdown-it';

export function uiDemoFence(markdown: MarkdownIt): void {
  const originalFence = markdown.renderer.rules.fence;

  markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index];

    if (token?.info !== 'html demo') {
      return originalFence?.(tokens, index, options, env, renderer) ?? renderer.renderToken(tokens, index, options);
    }

    const originalInfo = token.info;
    let code: string;

    try {
      token.info = 'html';
      code = originalFence?.(tokens, index, options, env, renderer)
        ?? renderer.renderToken(tokens, index, options);
    } finally {
      token.info = originalInfo;
    }

    const encodedHtml = encodeURIComponent(token.content);

    return `<div class="ui-demo">\n<UiHtmlDemo encoded-html="${encodedHtml}" />\n${code}</div>\n`;
  };
}
