import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  manifest: {
    name: 'PropSnap',
    description: 'Capture full property details from UK listing sites',
    version: '0.1.0',
    permissions: ['storage', 'activeTab'],
    host_permissions: [
      'https://www.rightmove.co.uk/*',
      'https://www.zoopla.co.uk/*',
      'https://www.openrent.com/*',
      'https://www.openrent.co.uk/*',
      'https://epc.opendatacommunities.org/*',
    ],
  },
});
