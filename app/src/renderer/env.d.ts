import type { ButlerApi } from '../shared/api'

declare global {
  interface Window {
    api: ButlerApi
  }
}

export {}
