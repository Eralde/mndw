import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitepress';

const typedocSidebarPath = resolve(import.meta.dirname, '../api/typedoc-sidebar.json');
const apiSidebar = existsSync(typedocSidebarPath)
  ? (JSON.parse(readFileSync(typedocSidebarPath, 'utf8')) as unknown[])
  : [];

export default defineConfig({
  title: 'mndw',
  description: 'Modular web UI for Keenetic/Netcraze routers.',
  lang: 'en-US',
  base: '/mndw/',
  vite: {
    resolve: {
      alias: [
        {
          find: /^.*\/VPNavBarHamburger\.vue$/,
          replacement: fileURLToPath(new URL('./theme/components/SidebarToggle.vue', import.meta.url)),
        },
      ],
    },
  },
  themeConfig: {
    nav: [],
    sidebar: {
      '/api/': [{text: '← Documentation', link: '/'}, ...apiSidebar],
      '/': [
        {
          text: 'Overview',
          items: [
            {text: 'What is mndw', link: '/'},
            {text: 'Install on the router', link: '/install'},
          ],
        },
        {
          text: 'Plugins: getting started',
          items: [
            {text: 'Project setup', link: '/guides/project-setup'},
            {text: 'Windows', link: '/guides/windows'},
            {text: 'Hello Widget', link: '/tutorials/hello-widget'},
            {text: 'Device name (RCI)', link: '/tutorials/rci-device-name-widget'},
          ],
        },
        {
          text: 'Guides',
          items: [
            {text: 'Plugin anatomy', link: '/guides/plugin-anatomy'},
            {text: 'Manifest', link: '/guides/manifest'},
            {text: 'Frontend lifecycle', link: '/guides/frontend-lifecycle'},
            {text: 'RxJS for plugin authors', link: '/guides/rxjs'},
            {text: 'Styling and UI', link: '/guides/styling-and-ui'},
            {text: 'Shared UI components', link: '/guides/ui-components'},
            {text: 'Shell backend', link: '/guides/shell-backend'},
            {text: 'RCI API', link: '/guides/rci-api'},
            {text: 'Local development', link: '/guides/local-development'},
            {text: 'Validation and packaging', link: '/guides/validation-and-packaging'},
          ],
        },
        {
          text: 'Reference',
          items: [
            {text: 'CLI commands', link: '/reference/cli'},
            {text: 'SDK API', link: '/api/'},
          ],
        },
      ],
    },
    search: {provider: 'local'},
    socialLinks: [{icon: 'github', link: 'https://github.com/Eralde/mndw'}],
    editLink: {
      pattern: 'https://github.com/Eralde/mndw/edit/master/docs/plugin-author/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Built from the mndw repository documentation.',
    },
  },
});
