import type { MessageInstance } from 'antd/es/message/interface'

let globalMessageApi: MessageInstance | null = null

export function setGlobalMessageApi(messageApi: MessageInstance) {
  globalMessageApi = messageApi
}

export function getGlobalMessageApi() {
  return globalMessageApi
}
