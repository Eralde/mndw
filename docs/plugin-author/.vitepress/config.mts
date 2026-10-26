import {defineConfig} from 'vitepress';

export default defineConfig({
  title: 'mndw Plugin Author Guide',
  description: 'Build, test, and package plugins for mndw.',
  lang: 'en-US',
  base: '/mndw/',
  themeConfig: {
    nav: [
      {text: 'Home', link: '/'},
      {text: 'Tutorials', link: '/tutorials/hello-widget'},
      {text: 'Guides', link: '/guides/plugin-anatomy'},
    ],
    sidebar: [
      {
        text: 'Tutorials',
        items: [
          {text: 'Shell-backed widget', link: '/tutorials/hello-widget'},
          {text: 'Direct RCI widget', link: '/tutorials/rci-device-name-widget'},
        ],
      },
      {
        text: 'Guides',
        items: [
          {text: 'Plugin anatomy', link: '/guides/plugin-anatomy'},
          {text: 'Manifest', link: '/guides/manifest'},
          {text: 'Frontend lifecycle', link: '/guides/frontend-lifecycle'},
          {text: 'Styling and UI', link: '/guides/styling-and-ui'},
          {text: 'Shared UI components', link: '/guides/ui-components'},
          {text: 'Shell backend', link: '/guides/shell-backend'},
          {text: 'RCI API', link: '/guides/rci-api'},
          {text: 'Local development', link: '/guides/local-development'},
          {text: 'Validation and packaging', link: '/guides/validation-and-packaging'},
        ],
      },
    ],
    search: {provider: 'local'},
    socialLinks: [{icon: 'github', link: 'https://github.com/Eralde/mndw'}],
    editLink: {
      pattern: 'https://github.com/Eralde/mndw/edit/main/docs/plugin-author/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Built from the mndw repository documentation.',
    },
  },
});
