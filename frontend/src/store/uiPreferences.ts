import { create } from 'zustand'
import { authApi } from '../services/api'

interface UiPreferencesState {
  preferences: Record<string, any>
  getColumnVisibility: (pageKey: string, defaultColumns: string[]) => string[]
  setColumnVisibility: (pageKey: string, visibleColumns: string[]) => void
  getColumnOrder: (pageKey: string, defaultOrder: string[]) => string[]
  setColumnOrder: (pageKey: string, order: string[]) => void
  getColumnWidths: (pageKey: string, defaults: Record<string, number>) => Record<string, number>
  setColumnWidths: (pageKey: string, widths: Record<string, number>) => void
  loadFromUser: (user: any) => void
  getFlag: (key: string, defaultValue?: any) => any
  setFlag: (key: string, value: any) => void
}

const UI_PREFS_KEY = 'spc_ui_preferences'

function readLocalPrefs(): Record<string, any> {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export const useUiPreferencesStore = create<UiPreferencesState>((set, get) => {
  const initial = readLocalPrefs()

  return {
    preferences: initial,

    getColumnVisibility: (pageKey, defaultColumns) => {
      const prefs = get().preferences
      const page = prefs[pageKey]
      if (page && Array.isArray(page.visibleColumns)) {
        return page.visibleColumns
      }
      return defaultColumns
    },

    setColumnVisibility: (pageKey, visibleColumns) => {
      const next = {
        ...get().preferences,
        [pageKey]: { ...get().preferences[pageKey], visibleColumns },
      }
      set({ preferences: next })
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next))

      authApi.updatePreferences({ ui_preferences: next }).catch((err: Error) => {
        console.error('Failed to save column visibility preference:', err)
      })
    },

    getColumnOrder: (pageKey, defaultOrder) => {
      const prefs = get().preferences
      const page = prefs[pageKey]
      if (page && Array.isArray(page.columnOrder) && page.columnOrder.length > 0) {
        return page.columnOrder
      }
      return defaultOrder
    },

    setColumnOrder: (pageKey, order) => {
      const next = {
        ...get().preferences,
        [pageKey]: { ...get().preferences[pageKey], columnOrder: order },
      }
      set({ preferences: next })
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next))
      authApi.updatePreferences({ ui_preferences: next }).catch((err: Error) => {
        console.error('Failed to save column order preference:', err)
      })
    },

    getColumnWidths: (pageKey, defaults) => {
      const page = get().preferences[pageKey]
      if (page && page.columnWidths && typeof page.columnWidths === 'object') {
        return { ...defaults, ...page.columnWidths }
      }
      return defaults
    },

    setColumnWidths: (pageKey, widths) => {
      const next = {
        ...get().preferences,
        [pageKey]: { ...get().preferences[pageKey], columnWidths: widths },
      }
      set({ preferences: next })
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next))
      authApi.updatePreferences({ ui_preferences: next }).catch((err: Error) => {
        console.error('Failed to save column widths preference:', err)
      })
    },

    getFlag: (key, defaultValue = false) => {
      const v = get().preferences[key]
      return v === undefined ? defaultValue : v
    },

    setFlag: (key, value) => {
      const next = { ...get().preferences, [key]: value }
      set({ preferences: next })
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next))
      authApi.updatePreferences({ ui_preferences: next }).catch((err: Error) => {
        console.error(`Failed to save UI flag [${key}]:`, err)
      })
    },

    loadFromUser: (user) => {
      if (user?.ui_preferences && typeof user.ui_preferences === 'object') {
        const merged = { ...readLocalPrefs(), ...user.ui_preferences }
        localStorage.setItem(UI_PREFS_KEY, JSON.stringify(merged))
        set({ preferences: merged })
      }
    },
  }
})
