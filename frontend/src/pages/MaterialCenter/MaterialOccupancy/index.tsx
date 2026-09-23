import { useCallback, useState } from 'react'
import { ReloadOutlined, DownloadOutlined } from '@ant-design/icons'
import { Button, message } from 'antd'
import './occupancy.css'
import ByMaterialTab from './ByMaterialTab'
import ByOrderTab from './ByOrderTab'

type ViewKey = 'm' | 'o'

export default function MaterialOccupancy() {
  const [view, setView] = useState<ViewKey>('m')
  const [drillMaterialCode, setDrillMaterialCode] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const handleDrillMaterial = useCallback((code: string) => {
    setDrillMaterialCode(code)
    setView('m')
  }, [])

  return (
    <div className="occ-page">
      <div className="occ-head">
        <div>
          <h1>物料占用分析</h1>
          <div className="sub">一个物料的库存被哪些订单、按什么顺序占用 · 实时计算，不落库</div>
        </div>
        <div className="actions">
          <div className="occ-seg">
            <span
              className={view === 'm' ? 'active' : ''}
              onClick={() => setView('m')}
            >
              按物料
            </span>
            <span
              className={view === 'o' ? 'active' : ''}
              onClick={() => setView('o')}
            >
              按订单 BOM
            </span>
          </div>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setRefreshKey((k) => k + 1)}>
            刷新
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => message.info('请先查询，再在结果区点击「导出 CSV」')}
          >
            导出
          </Button>
        </div>
      </div>

      {view === 'm' ? (
        <ByMaterialTab
          refreshKey={refreshKey}
          drillMaterialCode={drillMaterialCode}
          onDrillConsumed={() => setDrillMaterialCode(null)}
        />
      ) : (
        <ByOrderTab refreshKey={refreshKey} onDrillMaterial={handleDrillMaterial} />
      )}
    </div>
  )
}
