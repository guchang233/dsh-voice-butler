import { useEffect, useState } from 'react'
import { allSkins, refreshSkins } from '../shared/skins'

type Props = {
  current: string
  onPick: (key: string) => Promise<void>
  onRefresh: () => Promise<void>
}

/** 贴图网格。自己导入的可以右键改名或删除。 */
export default function SkinGrid({ current, onPick, onRefresh }: Props): JSX.Element {
  const [menu, setMenu] = useState<{ key: string; label: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<{ key: string; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const skins = allSkins()

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const commitRename = async (): Promise<void> => {
    const target = editing
    setEditing(null)
    if (!target) return
    const label = target.label.trim()
    if (!label) return
    const result = await window.api.renameSkin(target.key, label)
    if (!result.ok) {
      setError(result.error ?? '改名失败')
      return
    }
    setError(null)
    await refreshSkins()
    await onRefresh()
  }

  const removeOne = async (key: string): Promise<void> => {
    setMenu(null)
    const removed = await window.api.removeSkin(key)
    if (!removed) {
      setError('这张贴图已经不在了')
      return
    }
    setError(null)
    await refreshSkins()
    await onRefresh()
  }

  const importOne = async (): Promise<void> => {
    const result = await window.api.importSkin()
    if (!result.ok || !result.key) return
    await refreshSkins()
    await onPick(result.key)
  }

  return (
    <>
      <div className="skin-grid">
        <div
          className="skin-cell is-add"
          role="button"
          tabIndex={0}
          title="导入一张图片当贴图"
          onClick={() => void importOne()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void importOne()
            }
          }}
        >
          <span className="skin-plus">＋</span>
          <span className="skin-name">导入图片</span>
        </div>
        {skins.map((item) => {
          const custom = item.key.startsWith('user-')
          if (editing?.key === item.key) {
            return (
              <div key={item.key} className="skin-cell is-editing">
                <input
                  className="skin-rename"
                  autoFocus
                  maxLength={20}
                  value={editing.label}
                  onChange={(event) => setEditing({ key: item.key, label: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      setEditing(null)
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void commitRename()
                    }
                  }}
                  onBlur={() => void commitRename()}
                  spellCheck={false}
                />
                <span className="skin-name">回车保存</span>
              </div>
            )
          }
          return (
            <div
              key={item.key}
              className={current === item.key ? 'skin-cell is-on' : 'skin-cell'}
              role="button"
              tabIndex={0}
              title={custom ? `${item.label}（右键改名 / 删除）` : item.label}
              onClick={() => void onPick(item.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void onPick(item.key)
                }
              }}
              onContextMenu={(event) => {
                if (!custom) return
                event.preventDefault()
                event.stopPropagation()
                setMenu({
                  key: item.key,
                  label: item.label,
                  x: Math.min(event.clientX, window.innerWidth - 132),
                  y: Math.min(event.clientY, window.innerHeight - 86),
                })
              }}
            >
              <img className="skin-thumb" src={item.url} alt="" draggable={false} />
              <span className="skin-name">{item.label}</span>
            </div>
          )
        })}
      </div>
      {error && <span className="skin-error">{error}</span>}
      {menu && (
        <div
          className="skin-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setEditing({ key: menu.key, label: menu.label })
              setMenu(null)
            }}
          >
            改名
          </button>
          <button type="button" className="is-danger" onClick={() => void removeOne(menu.key)}>
            删除
          </button>
        </div>
      )}
    </>
  )
}
