import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/plugin.js',
            name: 'RoomTypeChatPlugin',
            formats: ['iife'],
            fileName: () => 'plugin.js',
        },
        outDir: '.',
        emptyOutDir: false,
        cssFileName: 'plugin-hljs',
        rollupOptions: {
            output: {
                assetFileNames: 'plugin-hljs[extname]',
            },
        },
    },
});
