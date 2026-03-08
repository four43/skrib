import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/plugin.js',
            name: 'RoomTypeTodoPlugin',
            formats: ['iife'],
            fileName: () => 'plugin.js',
        },
        outDir: 'dist',
    },
});
