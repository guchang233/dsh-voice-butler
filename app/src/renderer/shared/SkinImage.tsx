import { useEffect, useReducer } from 'react'
import { useState } from 'react'
import { ensureSkinsLoaded, skinUrl, subscribeSkins } from './skins'

/** 当前皮肤（= 贴图），跟着主进程广播走 */
export function useSkin(): string {
  const [skin, setSkin] = useState('whale')
  useEffect(() => {
    void window.api.getSkin().then((value) => setSkin(value || 'whale'))
    return window.api.onSkin((value) => setSkin(value || 'whale'))
  }, [])
  return skin
}

/** 贴图表变了就重渲染 */
export function useSkinTick(): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let alive = true
    void ensureSkinsLoaded().then(() => {
      if (alive) bump()
    })
    const off = subscribeSkins(() => bump())
    return () => {
      alive = false
      off()
    }
  }, [])
  return tick
}

export function SkinImage({ className, alt = '' }: { className: string; alt?: string }): JSX.Element {
  const skin = useSkin()
  useSkinTick()
  return <img className={className} src={skinUrl(skin)} alt={alt} draggable={false} />
}
