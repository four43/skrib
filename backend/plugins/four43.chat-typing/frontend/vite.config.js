import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/plugin.js',
            name: 'TypingPlugin',
            formats: ['iife'],
            fileName: () => 'plugin.js',
        },
        outDir: 'dist',
    },
});
