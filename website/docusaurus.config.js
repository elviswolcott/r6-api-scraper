const siteConfig = {
  title: 'Unofficial Rainbow Six API Docs',
  tagline: 'Unofficial documentation and assets for building apps for Rainbow Six: Seige',
  url: 'https://r6.elviswolcott.com',
  baseUrl: '/',
  favicon: 'img/favicon.ico',

  presets: [
    [
      '@docusaurus/preset-classic',
      {
        docs: {
          // docs folder path relative to website dir.
          path: './docs',
          // sidebars file relative to website dir.
          sidebarPath: require.resolve('./sidebars.json'),
        },
        theme: {
          customCss: require.resolve('./static/css/custom.css'),
        }
      },
    ],
  ],

  themeConfig: {
    navbar: {
      title: 'Unofficial Rainbow Six API Docs',
      logo: {
        alt: 'Rainbow Six Siege Desktop icon',
        src: 'img/favicon.ico'
      },
      links: [
        {to: 'docs/manifest', label: 'Manifest', position: 'right'},
        {to: 'docs/auto/requests', label: 'API', position: 'right'}
      ],
    },
    prism: {
      theme: require('prism-react-renderer/themes/duotoneDark'),
      defaultLanguage: 'typescript'
    },
    footer: {
      copyright: `Copyright © ${new Date().getFullYear()} Elvis Wolcott`,
    },
    sidebarCollapsible: true,
    image: 'img/banner.jpg',
    
  }
};

module.exports = siteConfig;
