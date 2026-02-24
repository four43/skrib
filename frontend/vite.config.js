import { defineConfig } from 'vite'
import { resolve } from 'path'
import { rename, readdir, rm } from 'fs/promises'

// HTML pages live in pages/ but are served at flat URLs (e.g. /login.html, not /pages/login.html)
function flatPages() {
  const htmlFiles = ['index.html', 'app.html', 'login.html', 'register.html', 'enroll-passkey.html', 'admin.html', 'settings.html', 'room-settings.html', 'prf-debug.html', 'key-recovery.html']

  return {
    name: 'flat-pages',

    // Dev: rewrite /foo.html -> /pages/foo.html
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url.split('?')[0]
        if (url === '/' || htmlFiles.some(f => url === '/' + f)) {
          const file = url === '/' ? 'index.html' : url.slice(1)
          req.url = req.url.replace(url, '/pages/' + file)
        }
        next()
      })
    },

    // Build: move dist/pages/*.html -> dist/*.html, remove dist/pages/
    async closeBundle() {
      const pagesDir = resolve(__dirname, 'dist', 'pages')
      try {
        const files = await readdir(pagesDir)
        for (const file of files) {
          await rename(resolve(pagesDir, file), resolve(__dirname, 'dist', file))
        }
        await rm(pagesDir, { recursive: true })
      } catch {
        // pages dir may not exist if build didn't produce it
      }
    }
  }
}

export default defineConfig({
  plugins: [flatPages()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'pages/index.html'),
        app: resolve(__dirname, 'pages/app.html'),
        login: resolve(__dirname, 'pages/login.html'),
        register: resolve(__dirname, 'pages/register.html'),
        enrollPasskey: resolve(__dirname, 'pages/enroll-passkey.html'),
        admin: resolve(__dirname, 'pages/admin.html'),
        settings: resolve(__dirname, 'pages/settings.html'),
        roomSettings: resolve(__dirname, 'pages/room-settings.html'),
        prfDebug: resolve(__dirname, 'pages/prf-debug.html'),
        keyRecovery: resolve(__dirname, 'pages/key-recovery.html'),
      },
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: ['.pinggy.link'],
    headers: {
      'Cache-Control': 'no-store',
    },
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://host.docker.internal:8000',
        changeOrigin: true,
        secure: false,
        ws: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('proxy error', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('Sending Request to the Target:', req.method, req.url);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
          });
        },
      }
    }
  }
})
