// @ts-check
import { defineConfig } from 'astro/config';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@astrojs/react';
import vercel from '@astrojs/vercel';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const localDataRoot = join(projectRoot, '.data');

/** @param {string} directory @returns {string[]} */
function listLocalDataFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listLocalDataFiles(absolutePath);
    }

    return entry.isFile() ? [relative(projectRoot, absolutePath).replaceAll('\\', '/')] : [];
  });
}

// https://astro.build/config
export default defineConfig({
  output: 'static',
  adapter: vercel({
    // Local fallback data can contain customer uploads and must never ship in a function bundle.
    excludeFiles: listLocalDataFiles(localDataRoot),
  }),
  integrations: [react()],
  devToolbar: {
    enabled: false,
  },
});
