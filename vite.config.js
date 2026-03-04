import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  // Set this to '/your-repo-name/' if deploying to GitHub Pages,
  // leave as '/' for Netlify / Vercel
  base: '/',
  plugins: [
    // Copy the data/ folder (GeoJSON + TIF rasters) into dist/data/
    viteStaticCopy({
      targets: [{ src: 'data', dest: '.' }],
    }),
  ],
  server: {
    port: 3000,
    open: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  assetsInclude: ['**/*.pmtiles', '**/*.tif', '**/*.tiff', '**/*.geojson'],
  optimizeDeps: {
    include: ['maplibre-gl', 'pmtiles', 'georaster', 'geotiff', 'proj4'],
  },
  build: {
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          raster:   ['georaster', 'geotiff'],
        },
      },
    },
  },
})
