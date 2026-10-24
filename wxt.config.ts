import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  manifest: {
    name: 'PropSnap',
    description: 'Capture full property details from UK listing sites',
    version: '0.7.0',
    icons: {
      16: '/icons/icon-16.png',
      32: '/icons/icon-32.png',
      48: '/icons/icon-48.png',
      128: '/icons/icon-128.png',
    },
    action: {
      default_icon: {
        16: '/icons/icon-16.png',
        32: '/icons/icon-32.png',
        48: '/icons/icon-48.png',
        128: '/icons/icon-128.png',
      },
    },
    permissions: ['storage', 'activeTab'],
    host_permissions: [
      'https://www.rightmove.co.uk/*',
      'https://www.zoopla.co.uk/*',
      'https://www.openrent.com/*',
      'https://www.openrent.co.uk/*',
      'https://api.get-energy-performance-data.communities.gov.uk/*',
      'https://landregistry.data.gov.uk/*',
      // Area checks: flood zones, planning areas, street crime, postcode positions
      'https://environment.data.gov.uk/*',
      'https://www.planning.data.gov.uk/*',
      'https://datamap.gov.wales/*',
      'https://data.police.uk/*',
      'https://api.postcodes.io/*',
    ],
  },
});
