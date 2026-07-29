import { create } from 'zustand'
import { productionApi } from '../services/api'

export interface BaseConditionItem {
  schedule_bucket: string
  bucket_label: string
  default_manpower: number
  daily_work_hours: number
  include_sunday: boolean
}

interface BaseConditionState {
  items: BaseConditionItem[]
  loaded: boolean
  loading: boolean
  lastLoadAt: number
  load: (force?: boolean) => Promise<void>
  getItem: (bucket?: string | null) => BaseConditionItem | null
  setItems: (items: BaseConditionItem[]) => void
}

const CACHE_TTL_MS = 5 * 60 * 1000  // 5 分钟

export const useBaseConditionStore = create<BaseConditionState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  lastLoadAt: 0,

  load: async (force = false) => {
    const { loading, lastLoadAt } = get()
    if (loading) return
    if (!force && lastLoadAt && (Date.now() - lastLoadAt < CACHE_TTL_MS)) return
    set({ loading: true })
    try {
      const res: any = await productionApi.getBaseConditions()
      const items: BaseConditionItem[] = res?.data || []
      set({ items, loaded: true, lastLoadAt: Date.now() })
    } catch (e) {
      // 静默失败，下次再试
      console.warn('load base conditions failed:', e)
    } finally {
      set({ loading: false })
    }
  },

  getItem: (bucket) => {
    if (!bucket) return null
    return get().items.find((it) => it.schedule_bucket === bucket) || null
  },

  setItems: (items) => {
    set({ items, loaded: true, lastLoadAt: Date.now() })
  },
}))
