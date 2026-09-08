import api from './api'
import { useAuthStore } from '../store/auth'

export interface DeployVersionRow {
  version: string
  current: boolean
  images: 'OK' | 'MISSING' | string
  created: string
  git: string
  note: string
  deployer: string
}

export interface DayCount {
  date: string
  count: number
  idle: boolean
}

export interface DeployStatus {
  current: string
  current_created: string
  current_created_rel: string
  current_git: string
  current_note: string
  current_deployer: string
  version_count: number
  retain_count: number
  compose_file: string
  git_url: string
  git_branch: string
  image_usage_bytes: number
  image_usage: string
  disk: { total?: number; used?: number; free?: number }
  deploy_history_last7: { count: number; days: DayCount[] }
}

export interface ImageDetail {
  name: string
  ok: boolean
  id_short: string
  size_mb: number
}

export interface SnapshotFile {
  name: string
  desc: string
  size: number | null
  exists: boolean
}

export interface ActivityEvent {
  ts: string
  ts_rel: string
  kind: 'deploy' | 'replaced' | 'current' | 'retained'
  title: string
  detail: string
}

export interface VersionDetail {
  version: string
  current: boolean
  images: ImageDetail[]
  images_state: 'OK' | 'MISSING'
  created: string
  created_rel: string
  git: string
  note: string
  deployer: string
  snapshots: SnapshotFile[]
  activity: ActivityEvent[]
}

export interface JobCreated {
  job_id: string
}

/** axios 拦截器已解包 HTTP，但保留 { code, message, data } 信封；此函数取 data。 */
async function unwrap<T>(p: Promise<any>): Promise<T> {
  const r: any = await p
  return (r?.data ?? r) as T
}

function getToken(): string {
  return useAuthStore.getState().currentToken || ''
}

/** SSE 自定义事件解析 */
export type DeployEventHandler = (ev: { name: string; data: any }) => void

function parseSseFrame(raw: string): { name: string; data: any } | null {
  let name = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  const joined = dataLines.join('\n')
  let parsed: any = joined
  try {
    parsed = JSON.parse(joined)
  } catch {
    /* keep raw text */
  }
  return { name, data: parsed }
}

/**
 * 部署任务实时流。fetch + ReadableStream 解析 SSE：
 * fetch 支持自定义 header，故走 Authorization Bearer（与 axios 一致），
 * 不把 token 放 query。返回关闭函数。
 */
export function openDeployJobStream(jobId: string, onEvent: DeployEventHandler): () => void {
  const controller = new AbortController()
  const token = getToken()
  const url = `/api/v1/system/deploy/jobs/${encodeURIComponent(jobId)}/stream`

  ;(async () => {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      })
      if (!res.ok || !res.body) {
        onEvent({ name: 'error', data: { detail: `HTTP ${res.status}` } })
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const ev = parseSseFrame(frame)
          if (ev) onEvent(ev)
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted) return
      onEvent({ name: 'error', data: { detail: String(err?.message || err) } })
    }
  })()

  return () => controller.abort()
}

export const deployApi = {
  list: () => unwrap<DeployVersionRow[]>(api.get('/system/deploy/versions')),
  detail: (version: string) =>
    unwrap<VersionDetail>(api.get(`/system/deploy/versions/${encodeURIComponent(version)}`)),
  status: () => unwrap<DeployStatus>(api.get('/system/deploy/status')),
  rollback: (version?: string) =>
    unwrap<JobCreated>(api.post('/system/deploy/rollback', { version: version ?? '' })),
  switch: (version: string) =>
    unwrap<JobCreated>(api.post('/system/deploy/switch', { version })),
  deployNew: (note: string, options: Record<string, any> = {}) =>
    unwrap<JobCreated>(api.post('/system/deploy/deploy-new', { note, options })),
  jobState: (jobId: string) => unwrap<any>(api.get(`/system/deploy/jobs/${jobId}`)),
}
