import type { TourProps } from 'antd'

export const STOCK_CHECK_INTRO_TOUR_ID = 'stock_check_intro'
export const STOCK_CHECK_DETAIL_TOUR_ID = 'stock_check_detail'
export const STOCK_CHECK_MANUAL_DETAIL_TOUR_ID = 'stock_check_manual_detail'

function dataTour(name: string): () => HTMLElement {
  return () => {
    const el = document.querySelector<HTMLElement>(`[data-tour="stock-check-${name}"]`)
    return el || (document.body as HTMLElement)
  }
}

export const stockCheckIntroSteps: TourProps['steps'] = [
  {
    title: '1. 搜索订单',
    description: '按订单号搜索,自动加载该订单的盘点单(订单盘点模式入口)。',
    target: dataTour('search'),
  },
  {
    title: '2. 为订单创建盘点单',
    description: '未找到盘点单时点此按钮,按订单 BOM 自动展开物料建单 (订单模式专用)。',
    target: dataTour('create'),
  },
  {
    title: '3. 手动盘点 — 选择物料',
    description: '无需订单,从物料库任意选择要盘点的物料(支持搜索/多选/查看即时库存),适合周期盘点、抽盘、专项盘点。',
    target: dataTour('manual-create'),
  },
  {
    title: '4. 按类型筛选',
    description: '在最近盘点单列表中可切换:全部 / 订单盘点 / 手动盘点 / 快捷盘点,快速定位历史记录。',
    target: dataTour('type-filter'),
  },
  {
    title: '5. 待盘点物料池(可选)',
    description:
      '按钮上的红色数字是你当前的待盘点物料池数量。多次搜索/不同关键词选到的物料可先加入池中,集中后再一次性创建盘点单;每次创建后只移除已使用的物料。',
    target: dataTour('pool-badge'),
  },
]

export const stockCheckDetailSteps: TourProps['steps'] = [
  {
    title: '1. 物料表的三个数',
    description: '应盘数 = BOM 需求(订单 × 单台用量),即时库存 = scm_inventory.qty_on_hand,盘点数 = 你录入的实盘。',
    target: dataTour('table'),
  },
  {
    title: '2. 差异列',
    description: '差异自动算出:盘点数 − 库存数。正数=盘盈,负数=盘亏。',
    target: dataTour('diff'),
  },
  {
    title: '3. 操作按钮',
    description: '保存全部 → 批量提交;标记完成 → 完结(需所有行都已录入实盘数);取消 → 终止该盘点单。',
    target: dataTour('actions'),
  },
]

export const stockCheckManualDetailSteps: TourProps['steps'] = [
  {
    title: '1. 物料表的三个数',
    description: '即时库存 = scm_inventory.qty_on_hand(聚合各仓库货位),盘点数 = 你录入的实盘;此处无 BOM 需求(应盘数=0),仅做库存核对。',
    target: dataTour('table'),
  },
  {
    title: '2. 差异列',
    description: '差异自动算出:盘点数 − 库存数。正数=盘盈,负数=盘亏。',
    target: dataTour('diff'),
  },
  {
    title: '3. 操作按钮',
    description: '保存全部 → 批量提交;标记完成 → 完结(需所有行都已录入实盘数);取消 → 终止该盘点单。',
    target: dataTour('actions'),
  },
]