import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'kws-worker': resolve(__dirname, 'src/main/audio/kws-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      // 麦克风 AudioWorklet 必须是独立文件；内联成 data: 会被生产环境 CSP 拦住
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          ball: resolve(__dirname, 'src/renderer/ball/index.html'),
          panel: resolve(__dirname, 'src/renderer/panel/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          peek: resolve(__dirname, 'src/renderer/peek/index.html'),
        },
      },
    },
  },
})
