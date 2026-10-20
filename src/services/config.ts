// API 配置：
// - 生产环境默认走同域相对路径（推荐由反向代理把 /api 转发到后端）
// - 开发环境推荐使用 Vite proxy（见 vite.config.ts），因此默认也走相对路径
// - 如需强制指定后端地址，可设置 VITE_API_BASE_URL
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

// 获取完整的 API URL（处理相对路径）
export function getApiUrl(path: string): string {
  if (path.startsWith('http')) return path;
  if (API_BASE_URL) return `${API_BASE_URL}${path}`;
  return path;
}

