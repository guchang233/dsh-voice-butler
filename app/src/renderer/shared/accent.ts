import type { Accent } from '../../shared/ipc'

export function applyAccent(accent: Accent | string | undefined): void {
  const root = document.documentElement
  if (accent === 'rose' || accent === 'ocean') root.dataset.accent = accent
  else delete root.dataset.accent
}

export function watchAccent(): void {
  void window.api.getSettings().then((settings) => applyAccent(settings.accent))
  window.api.onSettings((settings) => applyAccent(settings.accent))
}
