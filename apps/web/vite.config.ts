import { createServer, defineConfig, type Plugin } from 'vite';

// Use Vite's server-side JSX and environment transforms so the install guide reflects
// the same deployment flags as the interactive app. The renderer never listens on a port.
function hostedPages(): Plugin {
  let mode: string;
  return {
    configResolved(config) { mode = config.mode; },
    name: 'hosted-pages',
    enforce: 'post',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') throw new Error('Hosted pages require the built web entry.');
      const renderer = await createServer({ configFile: false, mode, appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null } });
      try {
        const { renderHostedFiles } = await renderer.ssrLoadModule('/editorial/pages.tsx') as typeof import('./editorial/pages');
        for (const [fileName, source] of Object.entries(renderHostedFiles(String(index.source), process.env.VERCEL_ENV === 'preview'))) {
          this.emitFile({ type: 'asset', fileName, source });
        }
        for (const file of renderer.environments.ssr.moduleGraph.fileToModulesMap.keys()) this.addWatchFile(file);
      } finally {
        await renderer.close();
      }
    },
  };
}

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  plugins: [hostedPages()],
  build: { outDir: 'dist', emptyOutDir: true },
});
