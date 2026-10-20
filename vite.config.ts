import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    // 在某些受限运行环境（如 Cursor sandbox）里，.env.local 可能因被忽略文件策略导致读取失败（EPERM）。
    // 这里做降级：读取失败则回退到 process.env，避免 dev server 直接启动失败。
    let env: Record<string, string> = {};
    try {
      env = loadEnv(mode, '.', '');
    } catch {
      env = (process.env || {}) as any;
    }
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        // 开发环境：把 /api 代理到后端，避免前端直接拿到 HTML（index.html）导致 JSON.parse 报错
        proxy: {
          '/api': {
            target: 'http://localhost:3001',
            changeOrigin: true,
          },
        },
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        }
      }
    };
});
