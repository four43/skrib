import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/plugin.js',
            name: 'WebPushPlugin',
            formats: ['iife'],
            fileName: () => 'plugin.js',
        },
        outDir: 'dist',
    },
});
