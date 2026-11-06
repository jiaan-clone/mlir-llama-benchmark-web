import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { PLATFORM_BASE_PATH, validatePlatformEnvironment } from './src/platformConfig.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  if (mode === 'platform') validatePlatformEnvironment(loadEnv(mode, process.cwd(), ''))
  return {
    base: mode === 'platform' ? PLATFORM_BASE_PATH : '/',
    plugins: [react()],
  }
})
