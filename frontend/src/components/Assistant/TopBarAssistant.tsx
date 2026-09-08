import React, { useEffect, useState } from 'react'
import { Drawer } from 'antd'
import { SearchOutlined, RobotOutlined } from '@ant-design/icons'
import ChatPanel from './ChatPanel'
import { useAssistantChat } from './useAssistantChat'

const TopBarAssistant: React.FC = () => {
  const [open, setOpen] = useState(false)
  const { messages, loading, send, skills, loadSkills, clearMessages, stopStreaming } = useAssistantChat()

  useEffect(() => {
    if (open && skills.length === 0) {
      loadSkills()
    }
  }, [open, skills.length, loadSkills])

  // Ctrl/Cmd + K 快捷键唤起
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <div className="tbv2-search" onClick={() => setOpen(true)} title="AI 全局搜索">
        <SearchOutlined style={{ fontSize: 14 }} />
        <span className="tbv2-search-text">搜索订单、物料、客户…</span>
        <kbd>Ctrl K</kbd>
      </div>
      <Drawer
        title={
          <span>
            <RobotOutlined style={{ marginRight: 8 }} />
            AI智能助手
          </span>
        }
        placement="right"
        width={480}
        open={open}
        onClose={() => setOpen(false)}
        styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' } }}
      >
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
          <ChatPanel
            messages={messages}
            loading={loading}
            skills={skills}
            onSend={send}
            onClear={clearMessages}
            onStop={stopStreaming}
          />
        </div>
      </Drawer>
    </>
  )
}

export default TopBarAssistant
