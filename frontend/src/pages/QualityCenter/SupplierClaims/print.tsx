import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Space } from 'antd'
import { ArrowLeftOutlined, PrinterOutlined } from '@ant-design/icons'
import { qualityApi, claimReasonText, claimItemText, claimReturnText } from '../../../services/quality'

const ACTION_TEXT: Record<string, string> = {
  submit: '提交', approve: '通过', reject: '驳回', recall: '撤回', auto_skip: '自动通过', revoked: '撤回审批',
}

export default function SupplierClaimPrint() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [r, setR] = useState<any>(null)

  useEffect(() => {
    (async () => {
      try {
        const res: any = await qualityApi.get(parseInt(id!))
        setR(res.data)
      } catch { /* 全局拦截器已提示 */ }
    })()
  }, [id])

  if (!r) return null

  const items = r.claim_items || []
  const logs = (r.approval_logs || []).filter((l: any) => l.action !== 'submit')
  const levels = [...new Set<number>(logs.map((l: any) => l.approval_level))]
  const snap = r.approval_snapshot || []
  const nodeLabel = (lv: number) => snap.find((n: any) => n.seq === lv)?.label || `第${lv}级意见`

  return (
    <div style={{ background: '#f5f5f5', minHeight: '100vh', padding: 16 }}>
      <Space style={{ marginBottom: 12 }} className="no-print">
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/quality/supplier-claims/${r.id}`)}>返回</Button>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>打印 / 另存为 PDF</Button>
      </Space>
      <div className="claim-print" style={{ background: '#fff', maxWidth: 900, margin: '0 auto', padding: 32 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            <tr>
              <td colSpan={3} style={{ border: '1px solid #000', padding: 8 }}>
                <div style={{ fontWeight: 700 }}>宁波恒剑光电科技有限公司</div>
                <div>IQC Department</div>
              </td>
              <td style={{ border: '1px solid #000', padding: 8, textAlign: 'center', fontWeight: 700, fontSize: 20 }}>
                供应商索赔通知单<br /><span style={{ fontSize: 12, fontWeight: 400 }}>Supplier Claim Confirmation</span>
              </td>
              <td style={{ border: '1px solid #000', padding: 8, fontSize: 12 }}>
                NO.: {r.claim_no}<br />Issue date: {r.claim_date || ''}<br />1/1
              </td>
            </tr>
            <tr>
              <td colSpan={5} style={{ border: '1px solid #000', padding: 8 }}>
                供应商 Supplier: <b>{r.supplier_name}</b>
              </td>
            </tr>
            <tr>
              <td colSpan={5} style={{ border: '1px solid #000', padding: 8 }}>
                索赔原因 Claim reason：{r.claim_reason === 'field_customer_claim' ? '■' : '□'} 现场/客户投诉 Field/customer claim
                {'　'}{r.claim_reason === 'supply_performance' ? '■' : '□'} 供货业绩 Supply performance
                <div style={{ fontSize: 12, marginTop: 4 }}>供应商索赔主要基于以下几个方面：交货和质量问题；制造过程中发现质量问题；导致我司客户索赔的质量问题。</div>
              </td>
            </tr>
            <tr>
              <td colSpan={5} style={{ border: '1px solid #000', padding: 8 }}>
                索赔细项 Details claimed：<br />
                {items.includes('replacement') ? '☑' : '□'} 替代件费用 Replacement{'　'}
                {items.includes('packing_fee') ? '☑' : '□'} 包装费用 Packing fee{'　'}
                {items.includes('transporting_fee') ? '☑' : '□'} 运输费用 Transporting fee<br />
                {items.includes('man_hour_fee') ? '☑' : '□'} 人工费用 Man-hour fee{'　'}
                {items.includes('additional_fee') ? '☑' : '□'} 额外费用 Additional fee{'　'}
                {items.includes('punishment') ? '☑' : '□'} 处罚 Punishment<br />
                {items.includes('downgrade_use') ? '☑' : '□'} 降级使用{'　'}
                {items.includes('direct_loss') ? '☑' : '□'} 直接损失
              </td>
            </tr>
            <tr>
              <td colSpan={5} style={{ border: '1px solid #000', padding: 8 }}>
                <div>索赔方式：{r.claim_method || '-'}</div>
                <div style={{ marginTop: 6 }}>索赔金额计算说明：</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{r.calc_explanation || '-'}</div>
                <div style={{ marginTop: 6 }}>
                  共计扣除费用 <b>{r.claim_amount != null ? Number(r.claim_amount).toLocaleString() : '-'}</b> 元人民币。
                </div>
                <div style={{ marginTop: 8, textAlign: 'right' }}>
                  品质部签字 Signature：{r.applicant_display || r.applicant || ''}　{r.claim_date || ''}
                </div>
              </td>
            </tr>
            <tr>
              <td colSpan={5} style={{ border: '1px solid #000', padding: 8 }}>
                退回要求 About parts returned from field：<br />
                {r.return_requirement === 'no_return' ? '☑' : '□'} 无需退回，由恒剑直接处理 Not need to return, please HJ handle it directly<br />
                {r.return_requirement === 'return_supplier_fee' ? '☑' : '□'} 需退回，供应商承担运费 Please return, supplier will be charge of the transporting fee.
              </td>
            </tr>
            {levels.map(lv => {
              const lvLogs = logs.filter((l: any) => l.approval_level === lv)
              const last = lvLogs[lvLogs.length - 1]
              return (
                <tr key={lv}>
                  <td colSpan={5} style={{ border: '1px solid #000', padding: 8 }}>
                    <div style={{ fontWeight: 600 }}>{nodeLabel(lv)}：</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{last?.comment || lvLogs.map((l: any) => `${l.approver} ${ACTION_TEXT[l.action] || l.action}`).join('；')}</div>
                    <div style={{ textAlign: 'right' }}>
                      签字 Signature：{lvLogs.map((l: any) => l.approver).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join('、')}
                      {last?.operated_at ? `　${String(last.operated_at).slice(0, 10)}` : ''}
                    </div>
                  </td>
                </tr>
              )
            })}
            <tr>
              <td colSpan={5} style={{ border: '1px solid #000', padding: 8 }}>
                备注：{r.remarks || '　'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <style>{`
        @media print {
          body { background: #fff; }
          .no-print { display: none !important; }
          .claim-print { max-width: none; padding: 0; }
        }
      `}</style>
    </div>
  )
}
