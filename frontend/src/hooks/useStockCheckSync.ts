import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/store/auth'

export interface SnapshotPayload {
  id: number
  version: number
  status?: string
  checked_materials?: number
  total_materials?: number
  total_diff_qty?: number
  co_checker_user_ids?: number[]
  co_checkers?: Array<{ user_id: number; name: string }>
  items: any[]
  [k: string]: any
}

export interface ItemUpdatedPayload {
  item_id: number
  version: number
  item: Record<string, any>
  head_aggregates: {
    checked_materials: number
    total_materials: number
    total_diff_qty: number
  }
}

export interface ItemsBatchUpdatedPayload {
  check_id: number
  items: Array<{ item_id: number; version: number; item: Record<string, any> }>
  head_aggregates?: {
    checked_materials: number
    total_materials: number
    total_diff_qty: number
  }
}

export interface StatusChangedPayload {
  check_id: number
  status: string
  head_version: number
  checked_by?: string
  completed_at?: string | null
}

export interface CoCheckersChangedPayload {
  check_id: number
  head_version: number
  co_checker_user_ids: number[]
  co_checkers: Array<{ user_id: number; name: string }>
}

export interface BomRefreshedPayload {
  check_id: number
  head_version: number
  new_item_ids: number[]
}

export interface WarehousesRefreshedPayload {
  check_id: number
  head_version: number
  stats?: Record<string, number>
}

export interface PresencePayload {
  user_id: number
  name: string | null
  item_id: number | null
}

interface ServerEvent {
  type: string
  payload: any
  origin_user_id?: number
}

export function useStockCheckSync(opts: {
  checkId: number | null
  onSnapshot: (p: SnapshotPayload) => void
  onItemUpdated: (p: ItemUpdatedPayload) => void
  onItemsBatchUpdated?: (p: ItemsBatchUpdatedPayload) => void
  onStatusChanged: (p: StatusChangedPayload) => void
  onCoCheckersChanged: (p: CoCheckersChangedPayload) => void
  onBomRefreshed: (p: BomRefreshedPayload) => void
  onWarehousesRefreshed?: (p: WarehousesRefreshedPayload) => void
  onPresence: (p: PresencePayload) => void
}): { connected: boolean; lastEventAt: number | null } {
  const { checkId, onSnapshot, onItemUpdated, onStatusChanged, onCoCheckersChanged, onBomRefreshed, onPresence } = opts
  const [connected, setConnected] = useState(false)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const esRef = useRef<EventSource | null>(null)
  // 用 ref 持有最新回调,避免回调变化导致重连
  const cbRef = useRef({ onSnapshot, onItemUpdated, onItemsBatchUpdated: opts.onItemsBatchUpdated, onStatusChanged, onCoCheckersChanged, onBomRefreshed, onWarehousesRefreshed: opts.onWarehousesRefreshed, onPresence })
  cbRef.current = { onSnapshot, onItemUpdated, onItemsBatchUpdated: opts.onItemsBatchUpdated, onStatusChanged, onCoCheckersChanged, onBomRefreshed, onWarehousesRefreshed: opts.onWarehousesRefreshed, onPresence }

  const currentUserId = useAuthStore.getState().currentUser?.id ?? 0

  useEffect(() => {
    if (checkId == null) return
    const token = useAuthStore.getState().currentToken
    if (!token) return

    const url = `/api/v1/materials/stock-check/${checkId}/events?token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    esRef.current = es

    es.onopen = () => { setConnected(true); console.log('[presence-debug] SSE 已连接, checkId=', checkId) }
    es.onerror = (err) => { setConnected(false); console.log('[presence-debug] SSE 错误/断开', err) }

    const dispatch = (e: MessageEvent) => {
      setLastEventAt(Date.now())
      let env: ServerEvent
      try {
        env = JSON.parse(e.data)
      } catch {
        return
      }
      // 诊断日志:记录所有 presence 事件(含自己的 echo)
      if (env.type === 'presence') {
        console.log('[presence-debug] 收到 presence 事件:', { origin: env.origin_user_id, me: currentUserId, payload: env.payload })
      }
      // 自己的不显示(包括自己的 presence echo —— 自己编辑哪行不需要提示)
      if (env.origin_user_id != null && Number(env.origin_user_id) === Number(currentUserId)) {
        return
      }
      switch (env.type) {
        case 'snapshot':
          cbRef.current.onSnapshot(env.payload)
          break
        case 'item_updated':
          cbRef.current.onItemUpdated(env.payload)
          break
        case 'items_batch_updated':
          cbRef.current.onItemsBatchUpdated?.(env.payload)
          break
        case 'status_changed':
          cbRef.current.onStatusChanged(env.payload)
          break
        case 'co_checkers_changed':
          cbRef.current.onCoCheckersChanged(env.payload)
          break
        case 'bom_refreshed':
          cbRef.current.onBomRefreshed(env.payload)
          break
        case 'warehouses_refreshed':
          cbRef.current.onWarehousesRefreshed?.(env.payload)
          break
        case 'presence':
          cbRef.current.onPresence(env.payload)
          break
        default:
          break
      }
    }
    ;['snapshot', 'item_updated', 'items_batch_updated', 'status_changed', 'co_checkers_changed', 'bom_refreshed', 'warehouses_refreshed', 'presence', 'error'].forEach(
      (t) => es.addEventListener(t, dispatch as EventListener),
    )

    return () => {
      es.close()
      esRef.current = null
      setConnected(false)
    }
  }, [checkId, currentUserId])

  return { connected, lastEventAt }
}
