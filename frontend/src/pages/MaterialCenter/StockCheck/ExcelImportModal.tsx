import { useState } from 'react'
import { Checkbox, Modal, Upload, Button, Alert, Typography, message, Space, Spin } from 'antd'
import { DownloadOutlined, InboxOutlined } from '@ant-design/icons'
import { materialApi } from '@/services/api'
import { useExport } from '@/hooks/useExport'

interface ImportResult {
  check_id: number
  check_no: string
  total: number
  added: number
  overwritten: number
  balanced: number
  loss: number
  gain: number
  skipped_not_today?: number
  skipped_dates?: Record<string, number>
}

interface DateBucket {
  date: string
  rows: number
  is_today: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  onImported: () => void
}

export default function ExcelImportModal({ open, onClose, onImported }: Props) {
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errors, setErrors] = useState<string[] | null>(null)
  const { exporting, exportData } = useExport()

  // 预览态: 上传后解析出的日期分布 + 勾选
  const [file, setFile] = useState<File | null>(null)
  const [buckets, setBuckets] = useState<DateBucket[] | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [importing, setImporting] = useState(false)

  const reset = () => {
    setResult(null); setErrors(null)
    setFile(null); setBuckets(null); setChecked([]); setImporting(false)
  }

  const errMsg = (e: any, fallback: string) =>
    e?.response?.data?.detail || e?.message || fallback

  const handleFile = async (f: File) => {
    setUploading(true); reset()
    try {
      const res: any = await materialApi.previewQuickCountExcel(f)
      const list: DateBucket[] = res.data?.dates || []
      // 文件里只有一个日期桶(含留空并入今天)→ 无需选择,直接导入
      if (list.length <= 1) {
        await doImport(f, list.map((b) => b.date))
        return
      }
      setFile(f)
      setBuckets(list)
      setChecked(list.filter((b) => b.is_today).map((b) => b.date))
    } catch (e: any) {
      const list: string[] | undefined = e?._apiData?.data?.errors
      if (list?.length) setErrors(list)
      else message.error(errMsg(e, '文件解析失败'))
    } finally {
      setUploading(false)
    }
  }

  const doImport = async (f: File, dates: string[]) => {
    setImporting(true)
    try {
      const res: any = await materialApi.importQuickCountExcel(f, dates)
      setResult(res.data)
      setBuckets(null); setFile(null); setChecked([])
      message.success(`已导入 ${res.data?.total ?? 0} 行到 ${res.data?.check_no}`)
      onImported()
    } catch (e: any) {
      const list: string[] | undefined = e?._apiData?.data?.errors
      if (list?.length) setErrors(list)
      else message.error(errMsg(e, '导入失败'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      title="Excel 导入快捷盘点"
      open={open}
      width={560}
      onCancel={() => { reset(); onClose() }}
      destroyOnClose
      footer={
        <Space>
          {buckets && (
            <Button
              type="primary" loading={importing} disabled={checked.length === 0}
              onClick={() => file && doImport(file, checked)}
            >导入选中日期({checked.length})</Button>
          )}
          <Button onClick={() => { reset(); onClose() }}>关闭</Button>
        </Space>
      }
    >
      {result && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={`已导入 ${result.check_no}:新增 ${result.added} 行、覆盖重盘 ${result.overwritten} 行`}
          description={`盘平 ${result.balanced} · 盘亏 ${result.loss} · 盘盈 ${result.gain}(共 ${result.total} 行)。核对无误后请在页面点「完结本单」。`
            + (result.skipped_not_today
              ? `已跳过未选日期 ${result.skipped_not_today} 行(${Object.entries(result.skipped_dates || {}).map(([d, n]) => `${d} ${n}行`).join('、')})。`
              : '')}
        />
      )}
      {errors && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`导入失败,共 ${errors.length} 处错误,未导入任何数据`}
          description={
            <ul style={{ maxHeight: 220, overflow: 'auto', paddingLeft: 18, margin: 0 }}>
              {errors.slice(0, 100).map((t, i) => (
                <li key={i}><Typography.Text type="danger" style={{ fontSize: 12 }}>{t}</Typography.Text></li>
              ))}
            </ul>
          }
        />
      )}
      {buckets ? (
        <div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            文件包含多个盘点日期,请勾选要导入的日期(所选数据均并入今日快捷盘点单,未勾选的跳过):
          </Typography.Paragraph>
          <Spin spinning={importing}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {buckets.map((b) => (
                <label
                  key={b.date}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                    border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer',
                    background: checked.includes(b.date) ? '#eff6ff' : '#fff',
                  }}
                >
                  <Checkbox
                    checked={checked.includes(b.date)}
                    onChange={(e) => {
                      setChecked((prev) =>
                        e.target.checked ? [...prev, b.date] : prev.filter((d) => d !== b.date))
                    }}
                  />
                  <span style={{ fontWeight: 500 }}>{b.date}{b.is_today ? '（今天，含未填日期行）' : ''}</span>
                  <span style={{ marginLeft: 'auto', color: '#64748b', fontSize: 12 }}>{b.rows} 行</span>
                </label>
              ))}
            </div>
          </Spin>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            想换文件请先点「关闭」重新打开
          </Typography.Paragraph>
        </div>
      ) : (
        <Upload.Dragger
          accept=".xlsx"
          showUploadList={false}
          disabled={uploading}
          beforeUpload={(f) => { handleFile(f); return false }}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">{uploading ? '正在解析…' : '点击或拖入 .xlsx 文件'}</p>
          <p className="ant-upload-hint">实盘数量留空=盘平;仓库留空=唯一仓库自动匹配(多仓库且盘平时自动展开每仓一行);含多个盘点日期时上传后可选择导入哪些日期;上限 5000 行;任一行错误则整份拒收</p>
        </Upload.Dragger>
      )}
      <div style={{ marginTop: 12 }}>
        <Button
          icon={<DownloadOutlined />} loading={exporting} size="small"
          onClick={() => exportData('/api/v1/materials/stock-check/quick-count/import-template', {}, '快捷盘点导入模板.xlsx')}
        >下载导入模板</Button>
      </div>
    </Modal>
  )
}
