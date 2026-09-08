import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from '../../../services/api'

export interface UseBdTableOptions {
  url: string
  extraQuery?: Record<string, any> | ((chip: string | number | null) => Record<string, any>)
  defaultPageSize?: number
  chipInit?: string | number | null
}

export function useBdTable<T = any>({
  url,
  extraQuery,
  defaultPageSize = 20,
  chipInit = null,
}: UseBdTableOptions) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [chip, setChipState] = useState<string | number | null>(chipInit)
  const [sortBy, setSortBy] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [reloadTick, setReloadTick] = useState(0)
  const reqIdRef = useRef(0)

  const extra = useMemo(
    () => (typeof extraQuery === 'function' ? extraQuery(chip) : extraQuery ?? {}),
    [extraQuery, chip],
  )
  const extraKey = JSON.stringify(extra)

  useEffect(() => {
    const reqId = ++reqIdRef.current
    setLoading(true)
    api
      .get(url, {
        params: {
          page,
          page_size: pageSize,
          ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
          ...(sortBy ? { sort_by: sortBy, sort_order: sortOrder } : {}),
          ...extra,
        },
      })
      .then((res: any) => {
        if (reqIdRef.current !== reqId) return
        setItems((res.data?.items || []) as T[])
        setTotal(res.data?.total || 0)
        if (res.data?.page) setPage(res.data.page)
        if (res.data?.page_size) setPageSize(res.data.page_size)
        setLoading(false)
      })
      .catch(() => {
        if (reqIdRef.current !== reqId) return
        setLoading(false)
      })
  }, [url, page, pageSize, keyword, sortBy, sortOrder, extraKey, reloadTick])

  const commitKeyword = useCallback(() => {
    setKeyword(keywordInput)
    setPage(1)
  }, [keywordInput])

  const setChip = useCallback((v: string | number | null) => {
    setChipState(v)
    setPage(1)
  }, [])

  const reload = useCallback(() => {
    setReloadTick((t) => t + 1)
  }, [])

  const onTableChange = useCallback(
    (pagination: any, _filters: Record<string, any>, sorter: any) => {
      const s = Array.isArray(sorter) ? sorter[0] : sorter
      const nextField: string | null = s?.order ? String(s.field ?? s.columnKey ?? '') || null : null
      const nextOrder: 'asc' | 'desc' = s?.order === 'ascend' ? 'asc' : 'desc'
      const sortChanged = nextField !== sortBy || (nextField !== null && nextOrder !== sortOrder)
      if (sortChanged) {
        setSortBy(nextField)
        if (nextField) setSortOrder(nextOrder)
      }
      setPage(sortChanged ? 1 : pagination?.current ?? page)
      if (pagination?.pageSize) setPageSize(pagination.pageSize)
    },
    [sortBy, sortOrder, page],
  )

  return {
    items,
    total,
    loading,
    page,
    pageSize,
    setPage,
    setPageSize,
    keyword,
    setKeywordInput,
    commitKeyword,
    chip,
    setChip,
    sortBy,
    sortOrder,
    onTableChange,
    reload,
  }
}
