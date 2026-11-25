// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 保留CHG-20261114-badge-overlay-b8023110宿主缺少关闭Hook的兼容，定位使用官方useBadgePosition。
import { useEffect } from 'react'
import type { RefObject } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

function useOutsidePointer(
  anchor: RefObject<HTMLElement | null>, open: boolean, close: (open: boolean) => void,
  panel: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !panel.current?.contains(event.target)) close(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside) }
  }, [open, anchor, panel, close])
}

/** Use the host's official hook when exported; older hosts retain outside dismissal. */
export const useBadgeDismiss = primitives.useDismissOnOutsidePointer ?? useOutsidePointer
