import { useMemo, useRef, useState } from 'react'
import { Modal, Select, InputNumber, Button, Space } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import { QRCodeSVG } from 'qrcode.react'
import './material-qrcode-print.css'

export interface LabelMaterial {
  material_code: string
  material_name: string
  spec_model?: string | null
}

const PRESETS = {
  a4: { label: 'A4 网格（3列×8行/页）' },
  w40h30: { label: '标签纸 40×30mm' },
  w50h30: { label: '标签纸 50×30mm' },
} as const

type PresetKey = keyof typeof PRESETS

/* 打印文档自包含样式：与预览 CSS 同口径(mm)，去掉屏幕装饰，加 @page 与分页 */
function printCss(preset: PresetKey): string {
  const base = `
    * { box-sizing: border-box; }
    body { margin: 0; }
    .qprint-sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2mm; }
    .qlabel { display: flex; align-items: center; gap: 2mm; height: 33mm; padding: 1.5mm; overflow: hidden; break-inside: avoid; }
    .qlabel__qr { flex: none; display: flex; width: 24mm; height: 24mm; }
    .qlabel__qr svg { width: 100%; height: 100%; }
    .qlabel__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.5mm; }
    .qlabel__code { font-family: ui-monospace, 'Courier New', monospace; font-weight: 700; font-size: 8pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qlabel__name { font-size: 7.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qlabel__spec { font-size: 7pt; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `
  const small = (w: 40 | 50, qr: number) => `
    * { box-sizing: border-box; }
    body { margin: 0; }
    .qprint-sheet { display: block; }
    .qlabel { display: flex; align-items: center; gap: 1mm; width: ${w - 2}mm; height: 28mm; overflow: hidden; break-after: page; page-break-after: always; }
    .qlabel:last-child { break-after: auto; page-break-after: auto; }
    .qlabel__qr { flex: none; display: flex; width: ${qr}mm; height: ${qr}mm; }
    .qlabel__qr svg { width: 100%; height: 100%; }
    .qlabel__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.5mm; }
    .qlabel__code { font-family: ui-monospace, 'Courier New', monospace; font-weight: 700; font-size: 6.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qlabel__name { font-size: 6pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qlabel__spec { font-size: 5.5pt; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `
  if (preset === 'a4') return `@page { size: A4; margin: 8mm; }${base}`
  if (preset === 'w40h30') return `@page { size: 40mm 30mm; margin: 1mm; }${small(40, 19)}`
  return `@page { size: 50mm 30mm; margin: 1mm; }${small(50, 22)}`
}

export default function MaterialQRCodePrintModal({
  open,
  materials,
  onClose,
}: {
  open: boolean
  materials: LabelMaterial[]
  onClose: () => void
}) {
  const [preset, setPreset] = useState<PresetKey>('a4')
  const [copies, setCopies] = useState(1)
  const previewRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const labels = useMemo(() => {
    const arr: LabelMaterial[] = []
    const n = Math.max(1, Math.min(99, copies || 1))
    for (let c = 0; c < n; c++) arr.push(...materials)
    return arr
  }, [materials, copies])

  function doPrint() {
    const frame = iframeRef.current
    const inner = previewRef.current?.innerHTML ?? ''
    if (!frame || !inner) return
    // previewRef 挂在 .qprint-sheet 上，innerHTML 只有标签子节点；
    // 打印文档必须重建 sheet 容器，否则 A4 的 3 列网格样式（.qprint-sheet grid）不生效
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>物料二维码标签</title><style>${printCss(preset)}</style></head><body><div class="qprint-sheet">${inner}</div></body></html>`
    frame.onload = () => {
      try {
        frame.contentWindow?.focus()
        frame.contentWindow?.print()
      } catch {
        /* 浏览器拦截打印时忽略 */
      }
    }
  }

  return (
    <Modal
      title={`二维码标签打印（${materials.length} 种物料 · ${labels.length} 张）`}
      open={open}
      onCancel={onClose}
      width={920}
      footer={[
        <Button key="close" onClick={onClose}>关闭</Button>,
        <Button key="print" type="primary" icon={<PrinterOutlined />} disabled={labels.length === 0} onClick={doPrint}>
          打印
        </Button>,
      ]}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <span>纸型：</span>
        <Select
          value={preset}
          onChange={(v) => setPreset(v as PresetKey)}
          style={{ width: 200 }}
          options={(Object.keys(PRESETS) as PresetKey[]).map((k) => ({ value: k, label: PRESETS[k].label }))}
        />
        <span>每种份数：</span>
        <InputNumber min={1} max={99} value={copies} onChange={(v) => setCopies(v ?? 1)} />
      </Space>
      <div className="qprint-preview">
        <div className={`qprint-sheet qprint-sheet--${preset}`} ref={previewRef}>
          {labels.map((m, i) => (
            <div className="qlabel" key={`${m.material_code}-${i}`}>
              <div className="qlabel__qr">
                <QRCodeSVG value={m.material_code} size={128} level="M" marginSize={1} />
              </div>
              <div className="qlabel__info">
                <div className="qlabel__code" title={m.material_code}>{m.material_code}</div>
                <div className="qlabel__name" title={m.material_name}>{m.material_name}</div>
                <div className="qlabel__spec" title={m.spec_model || ''}>{m.spec_model || '—'}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <iframe ref={iframeRef} title="qrcode-print" className="qprint-iframe" />
    </Modal>
  )
}
