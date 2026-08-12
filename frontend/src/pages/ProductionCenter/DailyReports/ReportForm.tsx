import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button, Space, Input, InputNumber, DatePicker, Select, Tag, message } from 'antd'
import {
  ArrowLeftOutlined, SaveOutlined, PlusOutlined, MinusOutlined, CopyOutlined,
} from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/api'
import { useAuthStore } from '../../../store/auth'

interface LeaveRow {
  key: number
  leave_date?: string
  employee_name?: string
  emp_code?: string
  leave_hours?: number
}

interface WorkRow {
  key: number
  work_date?: string
  employee_name?: string
  emp_code?: string
  total_hours?: number
  leave_hours?: number
  normal_hours?: number
  overtime_hours?: number
  hourly_wage?: number
  amount?: number
  modulus?: number
  daily_attendance?: string
}

interface TaskRow {
  key: number
  sale_order_no?: string
  production_order_no?: string
  public_material?: string
  specification?: string
  batch_qty?: number
  bom_no?: string
  material_code?: string
  process?: string
  process_remark?: string
  color?: string
  color_temp?: string
  product_unit_price?: number
  unit_price?: number
  completed_qty?: number
  amount?: number
  exception_amount?: number
  allocated_unit_price?: number
  allocated_amount?: number
}

interface Props {
  mode: 'create' | 'edit' | 'view'
}

interface OrgOption {
  id: number
  org_name: string
  org_code: string
  depth: number
  has_children: boolean
}

export default function WorkshopDailyReportForm({ mode }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const currentUser: any = useAuthStore((s: any) => s.currentUser)
  const reporter = currentUser?.display_name || currentUser?.username || ''

  const readonly = mode === 'view'
  const reportId = id ? Number(id) : null

  const [loading, setLoading] = useState(mode !== 'create')
  const [saving, setSaving] = useState(false)

  const [reportDate, setReportDate] = useState<string>(dayjs().format('YYYY-MM-DD'))
  const [reportType, setReportType] = useState('计件')
  const [department, setDepartment] = useState('')
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [orgOptions, setOrgOptions] = useState<OrgOption[]>([])
  const [groupName, setGroupName] = useState('')
  const [planQty, setPlanQty] = useState<number | null>(null)
  const [workHours, setWorkHours] = useState<number | null>(8)
  const [leader, setLeader] = useState('')
  const [repairer, setRepairer] = useState('')
  const [materialHandler, setMaterialHandler] = useState('')
  const [completedQty, setCompletedQty] = useState<number | null>(null)
  const [tempPersonnel, setTempPersonnel] = useState('')
  const [tempPeopleCount, setTempPeopleCount] = useState<number | null>(null)
  const [tempAmount, setTempAmount] = useState<number | null>(null)
  const [remark, setRemark] = useState('')
  const [reportNo, setReportNo] = useState('')

  const [leaveRows, setLeaveRows] = useState<LeaveRow[]>([])
  const [workRows, setWorkRows] = useState<WorkRow[]>([])
  const [taskRows, setTaskRows] = useState<TaskRow[]>([])

  const [selLeave, setSelLeave] = useState<Set<number>>(new Set())
  const [selWork, setSelWork] = useState<Set<number>>(new Set())
  const [selTask, setSelTask] = useState<Set<number>>(new Set())

  const title = `恒创车间日报表-${department || '未填部门'}-${reportDate}`

  // 选部门 → 按字段关联带出该车间的 组长/维修员/物料员
  const loadDeptPeople = async (orgId: number | null) => {
    if (!orgId) {
      setLeader('')
      setRepairer('')
      setMaterialHandler('')
      return
    }
    try {
      const res: any = await productionApi.workshopDailyReportPeopleOptions(orgId)
      const d = res.data || { leader: [], repairer: [], material_handler: [] }
      setLeader((d.leader?.[0]?.name) || '')
      setRepairer((d.repairer?.[0]?.name) || '')
      setMaterialHandler((d.material_handler?.[0]?.name) || '')
    } catch {
      setLeader('')
      setRepairer('')
      setMaterialHandler('')
    }
  }

  // 从打卡点算当日工时：末次-首次-1h午休
  const calcHoursFromPunch = (punch: string | undefined): number => {
    if (!punch) return 8
    const times = punch.trim().split(/\s+/).filter(Boolean)
    if (times.length < 2) return 8
    const parse = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
    const start = parse(times[0])
    const end = parse(times[times.length - 1])
    const net = Math.max(0, end - start - 60) // 减1h午休
    return Math.round((net / 60) * 100) / 100
  }

  // 选部门 → 自动带出该车间实际出勤人员到「出勤人员信息」明细表（含当日打卡点+工时工资+请假工时反写）
  const loadDeptAttendance = async (orgId: number | null, rq: string) => {
    if (!orgId) {
      setWorkRows([])
      return
    }
    try {
      const [attRes, leaveRes] = await Promise.all([
        productionApi.workshopDailyReportAttendanceOptions(orgId, rq),
        productionApi.workshopDailyReportLeaveOptions(orgId, rq),
      ])
      const people = attRes.data || []
      const leaveMap: Record<string, number> = {}
      ;(leaveRes.data || []).forEach((p: any) => { leaveMap[p.name] = p.leave_hours || 0 })
      setWorkRows(people.map((p: any) => {
        const wage = p.hourly_wage || 0
        const leaveH = leaveMap[p.name] || 0
        const totalH = calcHoursFromPunch(p.attendance_time)
        const effective = Math.max(0, totalH - leaveH)
        const normal = Math.min(8, effective)
        const overtime = Math.max(0, effective - 8)
        const actual = normal + overtime
        return {
          key: Date.now() + Math.random(),
          work_date: rq,
          employee_name: p.name,
          emp_code: p.emp_code,
          total_hours: totalH,
          leave_hours: leaveH,
          normal_hours: normal,
          overtime_hours: overtime,
          hourly_wage: wage,
          amount: Math.round(wage * actual * 100) / 100,
          modulus: 1,
          daily_attendance: p.attendance_time || '',
        }
      }))
    } catch {
      setWorkRows([])
    }
  }

  // 改日期 → 刷新打卡点并重算工时
  const refreshPunches = async (orgId: number | null, rq: string) => {
    if (!orgId || !rq) return
    try {
      const res: any = await productionApi.workshopDailyReportAttendanceOptions(orgId, rq)
      const punchMap: Record<string, string> = {}
      ;(res.data || []).forEach((p: any) => { if (p.name) punchMap[p.name] = p.attendance_time || '' })
      setWorkRows(rows => rows.map(r => {
        const punch = (r.employee_name && punchMap[r.employee_name]) ?? ''
        const totalH = calcHoursFromPunch(punch)
        const leaveH = r.leave_hours || 0
        const effective = Math.max(0, totalH - leaveH)
        const normal = Math.min(8, effective)
        const overtime = Math.max(0, effective - 8)
        const actual = normal + overtime
        const wage = r.hourly_wage || 0
        return {
          ...r,
          daily_attendance: punch,
          total_hours: totalH,
          normal_hours: normal,
          overtime_hours: overtime,
          amount: Math.round(wage * actual * 100) / 100,
        }
      }))
    } catch { /* ignore */ }
  }

  // 选部门+日期 → 自动带出该车间请假人员到「请假人员信息」明细表
  const loadDeptLeave = async (orgId: number | null, rq: string) => {
    if (!orgId || !rq) {
      setLeaveRows([])
      return
    }
    try {
      const res: any = await productionApi.workshopDailyReportLeaveOptions(orgId, rq)
      const people = res.data || []
      setLeaveRows(people.map((p: any) => ({
        key: Date.now() + Math.random(),
        leave_date: rq,
        employee_name: p.name,
        emp_code: p.emp_code,
        leave_hours: p.leave_hours,
      })))
    } catch {
      setLeaveRows([])
    }
  }

  const handleDeptChange = (v: number) => {
    setDepartmentId(v)
    const hit = orgOptions.find(o => o.id === v)
    setDepartment(hit ? hit.org_name : '')
    loadDeptPeople(v)
    loadDeptAttendance(v, reportDate)
    loadDeptLeave(v, reportDate)
  }

  const handleDateChange = (d: Dayjs | null) => {
    const rq = d ? d.format('YYYY-MM-DD') : ''
    setReportDate(rq)
    if (!departmentId) return
    // 明细行日期跟随报表日期
    setWorkRows(rows => rows.map(r => ({ ...r, work_date: rq })))
    setLeaveRows(rows => rows.map(r => ({ ...r, leave_date: rq })))
    loadDeptLeave(departmentId, rq)
    refreshPunches(departmentId, rq)
  }

  // 改「当日工时」→ 重算所有出勤行的 正班/加班/实际/金额（含请假扣减）
  const handleWorkHoursChange = (v: number | null) => {
    setWorkHours(v)
    const total = v ?? 8
    setWorkRows(rows => rows.map(r => {
      const leaveH = r.leave_hours || 0
      const effective = Math.max(0, total - leaveH)
      const normal = Math.min(8, effective)
      const overtime = Math.max(0, effective - 8)
      const actual = normal + overtime
      const wage = r.hourly_wage || 0
      return { ...r, total_hours: total, normal_hours: normal, overtime_hours: overtime, amount: Math.round(wage * actual * 100) / 100 }
    }))
  }

  // 改某行「当日工时」→ 只重算该行
  const handleRowTotalHours = (i: number, v: number | null) => {
    setWork(i, { total_hours: v ?? undefined })
    const total = v ?? 8
    setWorkRows(rows => rows.map((r, idx) => {
      if (idx !== i) return r
      const leaveH = r.leave_hours || 0
      const effective = Math.max(0, total - leaveH)
      const normal = Math.min(8, effective)
      const overtime = Math.max(0, effective - 8)
      const actual = normal + overtime
      const wage = r.hourly_wage || 0
      return { ...r, total_hours: total, normal_hours: normal, overtime_hours: overtime, amount: Math.round(wage * actual * 100) / 100 }
    }))
  }

  // 部门下拉数据源：供应链中心组织树
  useEffect(() => {
    (async () => {
      try {
        const res: any = await productionApi.workshopDailyReportOrgOptions()
        setOrgOptions(res.data || [])
      } catch {
        setOrgOptions([])
      }
    })()
  }, [])

  // 编辑回显：按部门名匹配 org_id（重名时取第一个，后续可改为存 department_id）
  useEffect(() => {
    if (department && orgOptions.length && departmentId == null) {
      const hit = orgOptions.find(o => o.org_name === department)
      if (hit) setDepartmentId(hit.id)
    }
  }, [department, orgOptions, departmentId])

  useEffect(() => {
    if (mode === 'create' || !reportId) return
    (async () => {
      try {
        const res: any = await productionApi.getWorkshopDailyReport(reportId)
        const d = res.data
        setReportDate(d.report_date || dayjs().format('YYYY-MM-DD'))
        setReportType(d.report_type || '计件')
        setDepartment(d.department || '')
        setGroupName(d.group_name || '')
        setPlanQty(d.plan_qty ?? null)
        setWorkHours(d.work_hours ?? null)
        setLeader(d.leader || '')
        setRepairer(d.repairer || '')
        setMaterialHandler(d.material_handler || '')
        setCompletedQty(d.completed_qty ?? null)
        setTempPersonnel(d.temp_personnel || '')
        setTempPeopleCount(d.temp_people_count ?? null)
        setTempAmount(d.temp_amount ?? null)
        setRemark(d.remark || '')
        setReportNo(d.report_no || '')
        setLeaveRows((d.leave_items || []).map((r: any) => ({ key: r.id, ...r })))
        setWorkRows((d.work_items || []).map((r: any) => ({ key: r.id, ...r })))
        setTaskRows((d.task_items || []).map((r: any) => ({ key: r.id, ...r })))
      } catch (e: any) {
        message.error(e?.response?.data?.detail || '加载失败')
        navigate('/daily-reports')
      } finally {
        setLoading(false)
      }
    })()
  }, [mode, reportId, navigate])

  // ---- 派生统计（自动计算） ----
  const attendanceCount = workRows.length
  const leaveCount = leaveRows.length
  const attendanceActual = Math.max(attendanceCount - leaveCount, 0)
  const leaveHoursTotal = leaveRows.reduce((s, r) => s + (r.leave_hours || 0), 0)
  const workWagesTotal = workRows.reduce((s, r) => s + (r.amount || 0), 0)
  const modulusTotal = workRows.reduce((s, r) => s + (r.modulus || 0), 0)
  const grandTotal = Math.round((workWagesTotal + (tempAmount || 0)) * 100) / 100
  const taskBatchTotal = taskRows.reduce((s, r) => s + (r.batch_qty || 0), 0)

  // ---- 行操作 ----
  const setLeave = (i: number, patch: Partial<LeaveRow>) =>
    setLeaveRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const setWork = (i: number, patch: Partial<WorkRow>) =>
    setWorkRows(rows => rows.map((r, idx) => {
      if (idx !== i) return r
      const next = { ...r, ...patch }
      if ('hourly_wage' in patch || 'modulus' in patch) {
        next.amount = Math.round((next.hourly_wage || 0) * (next.modulus || 1) * 100) / 100
      }
      return next
    }))
  const setTask = (i: number, patch: Partial<TaskRow>) =>
    setTaskRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const addLeave = () => setLeaveRows(rows => [...rows, { key: Date.now(), leave_date: reportDate }])
  const addWork = () => setWorkRows(rows => [...rows, { key: Date.now(), work_date: reportDate, modulus: 1 }])
  const addTask = () => setTaskRows(rows => [...rows, { key: Date.now() }])

  const delSelected = (
    rows: { key: number }[],
    sel: Set<number>,
    setRows: (fn: (r: any[]) => any[]) => void,
    setSel: (s: Set<number>) => void,
  ) => {
    const keys = sel.size > 0 ? sel : new Set<number>([rows[rows.length - 1]?.key])
    setRows(prev => prev.filter(r => !keys.has(r.key)))
    setSel(new Set())
  }

  const copySelected = (
    rows: { key: number }[],
    sel: Set<number>,
    setRows: (fn: (r: any[]) => any[]) => void,
    setSel: (s: Set<number>) => void,
  ) => {
    const keys = sel.size > 0 ? sel : new Set<number>([rows[rows.length - 1]?.key])
    const copied: any[] = []
    rows.forEach(r => {
      if (keys.has(r.key)) copied.push({ ...r, key: Date.now() + Math.random() })
    })
    if (copied.length) {
      setRows(prev => [...prev, ...copied])
    }
  }

  const toggleSel = (sel: Set<number>, key: number, setSel: (s: Set<number>) => void) => {
    const next = new Set(sel)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSel(next)
  }

  const toggleAll = (
    rows: { key: number }[],
    sel: Set<number>,
    setSel: (s: Set<number>) => void,
  ) => {
    if (rows.length && sel.size === rows.length) setSel(new Set())
    else setSel(new Set(rows.map(r => r.key)))
  }

  const cellCls = readonly ? 'f-cell f-cell-ro' : 'f-cell'

  // ---- 保存 ----
  const handleSave = async () => {
    if (!reportDate) { message.warning('请填写日期'); return }
    const payload = {
      report_date: reportDate,
      report_type: reportType || undefined,
      department: department || undefined,
      group_name: groupName || undefined,
      plan_qty: planQty ?? undefined,
      work_hours: workHours ?? undefined,
      leader: leader || undefined,
      repairer: repairer || undefined,
      material_handler: materialHandler || undefined,
      completed_qty: completedQty ?? undefined,
      temp_personnel: tempPersonnel || undefined,
      temp_people_count: tempPeopleCount ?? undefined,
      temp_amount: tempAmount ?? undefined,
      remark: remark || undefined,
      leave_items: leaveRows.map(({ leave_date, employee_name, emp_code, leave_hours }) => ({
        leave_date, employee_name, emp_code, leave_hours: leave_hours ?? undefined,
      })),
      work_items: workRows.map(r => ({
        work_date: r.work_date,
        employee_name: r.employee_name,
        emp_code: r.emp_code,
        total_hours: r.total_hours ?? undefined,
        leave_hours: r.leave_hours ?? undefined,
        normal_hours: r.normal_hours ?? undefined,
        overtime_hours: r.overtime_hours ?? undefined,
        actual_hours: (r.normal_hours || 0) + (r.overtime_hours || 0),
        hourly_wage: r.hourly_wage ?? undefined,
        amount: r.amount ?? undefined,
        modulus: r.modulus ?? undefined,
        daily_attendance: r.daily_attendance || undefined,
      })),
      task_items: taskRows.map((r) => ({
        sale_order_no: r.sale_order_no,
        production_order_no: r.production_order_no,
        public_material: r.public_material,
        specification: r.specification,
        batch_qty: r.batch_qty ?? undefined,
        bom_no: r.bom_no,
        material_code: r.material_code,
        process: r.process,
        process_remark: r.process_remark,
        color: r.color,
        color_temp: r.color_temp,
        product_unit_price: r.product_unit_price ?? undefined,
        unit_price: r.unit_price ?? undefined,
        completed_qty: r.completed_qty ?? undefined,
        amount: r.amount ?? undefined,
        exception_amount: r.exception_amount ?? undefined,
        allocated_unit_price: r.allocated_unit_price ?? undefined,
        allocated_amount: r.allocated_amount ?? undefined,
      })),
    }
    try {
      setSaving(true)
      if (reportId) await productionApi.updateWorkshopDailyReport(reportId, payload)
      else await productionApi.createWorkshopDailyReport(payload)
      message.success('保存成功')
      navigate('/daily-reports')
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80, color: '#5b6f8b' }}>加载中...</div>
  }

  return (
    <div style={{ padding: 20, background: '#f0f2f5', minHeight: '100vh' }}>
      <style>{`
        .wsdr-grid { max-width: 1100px; margin: 0 auto; background: #fff; padding: 24px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
        .wsdr-grid h2 { text-align: center; font-size: 20px; margin: 0 0 16px; color: #1f2f47; }
        .main-form-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        .main-form-table td { border: 1px solid #c8d6e5; padding: 6px 8px; vertical-align: middle; }
        .main-form-table td.lbl { background: #e8f4fc; text-align: right; width: 90px; white-space: nowrap; color: #1f2f47; }
        .main-form-table td.emp { background: #fff; }
        .required { color: red; }
        .f-cell { width: 100%; border: 1px solid #ccd6dd; padding: 4px 6px; height: 28px; border-radius: 2px; }
        .f-cell-ro { background: #f7f9fb; color: #5b6f8b; }
        .section-title { display: flex; align-items: center; font-size: 16px; font-weight: bold; margin: 20px 0 8px; color: #1f2f47; }
        .section-title .dot { display: inline-block; width: 8px; height: 16px; background-color: #f05023; margin-right: 6px; }
        .table-wrap { position: relative; overflow-x: auto; }
        .table-btn-group { position: absolute; right: 4px; top: -30px; z-index: 2; }
        .table-btn-group button { width: 28px; height: 26px; border: 1px solid #99b8d8; background: #fff; cursor: pointer; font-size: 16px; padding: 0; margin-left: 4px; color: #1f3a6b; border-radius: 2px; }
        .table-btn-group button:hover { background: #e8f4fc; }
        .table-btn-group button:disabled { opacity: .4; cursor: not-allowed; }
        .detail-table { width: 100%; border-collapse: collapse; background: #fff; }
        .detail-table th, .detail-table td { border: 1px solid #c8d6e5; padding: 5px 4px; text-align: center; }
        .detail-table th { background: #f2f6fb; color: #1f2f4a; font-weight: 600; white-space: nowrap; }
        .detail-table td input, .detail-table td .ant-picker { width: 100%; }
        .sum-row td { background: #e8f4fc; font-weight: bold; }
        .toolbar { max-width: 1100px; margin: 0 auto 12px; display: flex; justify-content: space-between; align-items: center; }
        .kv { display: flex; gap: 16px; flex-wrap: wrap; color: #1f2f47; }
      `}</style>

      <div className="toolbar">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/daily-reports')}>返回</Button>
          {!readonly && (
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>保存</Button>
          )}
        </Space>
        <div className="kv">
          <span>填报人：{reporter || '—'}</span>
          <span>{mode === 'view' ? '只读预览' : mode === 'edit' ? `编辑单据 · ${reportNo || ''}` : '新建单据'}</span>
        </div>
      </div>

      <div className="wsdr-grid">
        <h2>恒创车间日报表</h2>

        {/* 主表单 */}
        <table className="main-form-table">
          <tbody>
            <tr>
              <td className="lbl">报表类型</td>
              <td><Select size="small" value={reportType} disabled={readonly} style={{ width: '100%' }}
                onChange={v => setReportType(v)} options={[{ value: '计件', label: '计件' }, { value: '计时', label: '计时' }]} /></td>
              <td className="lbl">| 部门</td>
              <td>
                <Select
                  size="small"
                  showSearch
                  value={departmentId ?? undefined}
                  disabled={readonly}
                  style={{ width: '100%' }}
                  placeholder="选择部门"
                  onChange={handleDeptChange}
                  optionFilterProp="label"
                  options={orgOptions.map(o => ({
                    value: o.id,
                    label: `${'　'.repeat(o.depth)}${o.has_children ? '▸ ' : ''}${o.org_name}`,
                  }))}
                />
              </td>
              <td className="lbl">| 组别</td>
              <td><Input size="small" className={cellCls} value={groupName} disabled={readonly} onChange={e => setGroupName(e.target.value)} /></td>
              <td className="lbl" />
              <td className="emp" />
            </tr>
            <tr>
              <td className="lbl">标题</td>
              <td colSpan={3}><Input size="small" className="f-cell f-cell-ro" value={title} readOnly /></td>
              <td className="lbl" />
              <td className="emp" />
              <td className="lbl">流程编号</td>
              <td><Input size="small" className="f-cell f-cell-ro" value={reportNo || '保存后自动生成'} readOnly /></td>
            </tr>
            <tr>
              <td className="lbl">日期</td>
              <td><DatePicker size="small" value={reportDate ? dayjs(reportDate) : null} disabled={readonly} style={{ width: '100%' }}
                onChange={handleDateChange} /></td>
              <td className="lbl">计划数量</td>
              <td><InputNumber size="small" className={cellCls} value={planQty} disabled={readonly} min={0} onChange={v => setPlanQty(v)} /></td>
              <td className="lbl" />
              <td className="emp" />
              <td className="lbl">当日工时 <span className="required">*</span></td>
              <td><InputNumber size="small" className={cellCls} value={workHours} disabled={readonly} min={0} precision={1} onChange={handleWorkHoursChange} /></td>
            </tr>
            <tr>
              <td className="lbl">组长</td>
              <td><Input size="small" className={cellCls} value={leader} disabled={readonly} onChange={e => setLeader(e.target.value)} /></td>
              <td className="lbl">维修员</td>
              <td><Input size="small" className={cellCls} value={repairer} disabled={readonly} onChange={e => setRepairer(e.target.value)} /></td>
              <td className="lbl" />
              <td className="emp" />
              <td className="lbl">物料员</td>
              <td><Input size="small" className={cellCls} value={materialHandler} disabled={readonly} onChange={e => setMaterialHandler(e.target.value)} /></td>
            </tr>
            <tr>
              <td className="lbl">实际出勤人员 <span className="required">*</span></td>
              <td>
                <div className="f-cell f-cell-ro" style={{ height: 'auto', minHeight: 28, textAlign: 'left' }}>
                  {workRows.length === 0 ? <span style={{ color: '#b0bccb' }}>暂无</span> : workRows.map((r, i) => (
                    <Tag
                      key={r.key}
                      closable={!readonly}
                      onClose={() => setWorkRows(rows => rows.filter((_, idx) => idx !== i))}
                    >
                      {r.employee_name || r.emp_code || '未命名'}
                    </Tag>
                  ))}
                </div>
              </td>
              <td className="lbl">请假人员</td>
              <td><div className="f-cell f-cell-ro">{leaveCount}</div></td>
              <td className="lbl" />
              <td className="emp" />
              <td className="lbl">实际完成数 <span className="required">*</span></td>
              <td><InputNumber size="small" className={cellCls} value={completedQty} disabled={readonly} min={0} onChange={v => setCompletedQty(v)} /></td>
            </tr>
            <tr>
              <td className="lbl">实际出勤人数</td>
              <td><div className="f-cell f-cell-ro">{attendanceActual}</div></td>
              <td className="lbl">请假总时间</td>
              <td><div className="f-cell f-cell-ro">{leaveHoursTotal.toFixed(2)}</div></td>
              <td className="lbl" />
              <td className="emp" />
              <td className="lbl">当日总工资</td>
              <td><div className="f-cell f-cell-ro">{workWagesTotal.toFixed(2)}</div></td>
            </tr>
            <tr>
              <td className="lbl">临时工人员</td>
              <td><Input size="small" className={cellCls} value={tempPersonnel} disabled={readonly} placeholder="姓名" onChange={e => setTempPersonnel(e.target.value)} /></td>
              <td className="lbl">临时工人数</td>
              <td><InputNumber size="small" className={cellCls} value={tempPeopleCount} disabled={readonly} min={0} onChange={v => setTempPeopleCount(v)} /></td>
              <td className="lbl" />
              <td className="emp" />
              <td className="lbl">临时工金额</td>
              <td><InputNumber size="small" className={cellCls} value={tempAmount} disabled={readonly} min={0} precision={2} onChange={v => setTempAmount(v)} /></td>
            </tr>
            <tr>
              <td className="lbl">备注</td>
              <td colSpan={3}><Input size="small" className={cellCls} value={remark} disabled={readonly} onChange={e => setRemark(e.target.value)} /></td>
              <td className="lbl">总工资</td>
              <td><div className="f-cell f-cell-ro">{grandTotal.toFixed(2)}</div></td>
              <td className="lbl" />
              <td className="emp" />
            </tr>
          </tbody>
        </table>

        {/* 请假人员信息 */}
        <div className="section-title"><span className="dot" />请假人员信息</div>
        <div className="table-wrap">
          {!readonly && (
            <div className="table-btn-group">
              <Button type="default" size="small" icon={<PlusOutlined />} onClick={addLeave} />
              <Button type="default" size="small" danger icon={<MinusOutlined />} onClick={() => delSelected(leaveRows, selLeave, setLeaveRows, setSelLeave)} />
              <Button type="default" size="small" icon={<CopyOutlined />} onClick={() => copySelected(leaveRows, selLeave, setLeaveRows, setSelLeave)} />
            </div>
          )}
          <table className="detail-table" id="leaveTable">
            <thead>
              <tr>
                {!readonly && (
                  <th style={{ width: 34 }}><input type="checkbox"
                    checked={leaveRows.length > 0 && selLeave.size === leaveRows.length}
                    onChange={() => toggleAll(leaveRows, selLeave, setSelLeave)} /></th>
                )}
                <th style={{ width: 44 }}>序号</th><th>请假日期</th><th>人员姓名</th><th>工号</th><th>请假时间</th>
              </tr>
            </thead>
            <tbody>
              {leaveRows.map((r, i) => (
                <tr key={r.key}>
                  {!readonly && (
                    <td><input type="checkbox" checked={selLeave.has(r.key)}
                      onChange={() => toggleSel(selLeave, r.key, setSelLeave)} /></td>
                  )}
                  <td>{i + 1}</td>
                  <td><DatePicker size="small" value={r.leave_date ? dayjs(r.leave_date) : null} disabled={readonly} style={{ width: 130 }}
                    onChange={(d: Dayjs | null) => setLeave(i, { leave_date: d ? d.format('YYYY-MM-DD') : undefined })} /></td>
                  <td><Input size="small" value={r.employee_name} disabled={readonly} onChange={e => setLeave(i, { employee_name: e.target.value })} /></td>
                  <td><Input size="small" value={r.emp_code} disabled={readonly} onChange={e => setLeave(i, { emp_code: e.target.value })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.leave_hours} disabled={readonly} min={0} precision={1}
                    onChange={v => setLeave(i, { leave_hours: v ?? undefined })} /></td>
                </tr>
              ))}
              {leaveRows.length === 0 && (
                <tr><td colSpan={readonly ? 5 : 6} style={{ color: '#6b7e9c', padding: 10 }}>暂无请假人员，点击 + 添加</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 出勤人员信息 */}
        <div className="section-title"><span className="dot" />出勤人员信息</div>
        <div className="table-wrap">
          {!readonly && (
            <div className="table-btn-group">
              <Button type="default" size="small" icon={<PlusOutlined />} onClick={addWork} />
              <Button type="default" size="small" danger icon={<MinusOutlined />} onClick={() => delSelected(workRows, selWork, setWorkRows, setSelWork)} />
              <Button type="default" size="small" icon={<CopyOutlined />} onClick={() => copySelected(workRows, selWork, setWorkRows, setSelWork)} />
            </div>
          )}
          <table className="detail-table" id="workTable" style={{ minWidth: 1500 }}>
            <thead>
              <tr>
                {!readonly && (
                  <th style={{ width: 34 }}><input type="checkbox"
                    checked={workRows.length > 0 && selWork.size === workRows.length}
                    onChange={() => toggleAll(workRows, selWork, setSelWork)} /></th>
                )}
                <th style={{ width: 44 }}>序号</th><th>出勤日期</th><th>出勤人员姓名</th><th>工号</th>
                <th>当日工时</th><th>请假工时</th><th>正班工时</th><th>加班工时</th>
                <th>实际工时</th><th>工时工资</th><th>金额</th><th>模数</th><th>当日考勤情况</th>
              </tr>
            </thead>
            <tbody>
              {workRows.map((r, i) => (
                <tr key={r.key}>
                  {!readonly && (
                    <td><input type="checkbox" checked={selWork.has(r.key)}
                      onChange={() => toggleSel(selWork, r.key, setSelWork)} /></td>
                  )}
                  <td>{i + 1}</td>
                  <td><DatePicker size="small" value={r.work_date ? dayjs(r.work_date) : null} disabled={readonly} style={{ width: 120 }}
                    onChange={(d: Dayjs | null) => setWork(i, { work_date: d ? d.format('YYYY-MM-DD') : undefined })} /></td>
                  <td><Input size="small" value={r.employee_name} disabled={readonly} onChange={e => setWork(i, { employee_name: e.target.value })} /></td>
                  <td><Input size="small" style={{ width: 90 }} value={r.emp_code} disabled={readonly} onChange={e => setWork(i, { emp_code: e.target.value })} /></td>
                  <td><InputNumber size="small" style={{ width: 80 }} value={r.total_hours} disabled={readonly} min={0} precision={1}
                    onChange={v => handleRowTotalHours(i, v ?? null)} /></td>
                  <td><InputNumber size="small" style={{ width: 80 }} value={r.leave_hours} disabled={readonly} min={0} precision={1}
                    onChange={v => setWork(i, { leave_hours: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 80 }} value={r.normal_hours} disabled={readonly} min={0} precision={1}
                    onChange={v => setWork(i, { normal_hours: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 80 }} value={r.overtime_hours} disabled={readonly} min={0} precision={1}
                    onChange={v => setWork(i, { overtime_hours: v ?? undefined })} /></td>
                  <td style={{ fontWeight: 600 }}>{(r.normal_hours || 0) + (r.overtime_hours || 0)}</td>
                  <td><InputNumber size="small" style={{ width: 90 }} value={r.hourly_wage} disabled={readonly} min={0} precision={2}
                    onChange={v => setWork(i, { hourly_wage: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 90 }} value={r.amount} disabled={readonly} min={0} precision={2}
                    onChange={v => setWork(i, { amount: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 70 }} value={r.modulus} disabled={readonly} min={1}
                    onChange={v => setWork(i, { modulus: v ?? undefined })} /></td>
                  <td style={{ fontSize: 12, color: '#5b6f8b', whiteSpace: 'nowrap' }}>{r.daily_attendance || '-'}</td>
                </tr>
              ))}
              {workRows.length === 0 && (
                <tr><td colSpan={readonly ? 13 : 14} style={{ color: '#6b7e9c', padding: 10 }}>暂无出勤人员，点击 + 添加</td></tr>
              )}
            </tbody>
            {workRows.length > 0 && (
              <tbody>
                <tr className="sum-row">
                  <td colSpan={readonly ? 9 : 10} style={{ textAlign: 'right', paddingRight: 8 }}>合计</td>
                  <td>{(workRows.reduce((s, r) => s + (r.hourly_wage || 0), 0)).toFixed(2)}</td>
                  <td>{workWagesTotal.toFixed(2)}</td>
                  <td />
                  <td />
                </tr>
              </tbody>
            )}
          </table>
        </div>

        {/* 选择K3任务单 */}
        <div className="section-title"><span className="dot" />选择K3任务单</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input size="small" style={{ width: 300 }} placeholder="搜索任务单（取数逻辑待接入）" disabled={readonly || true} />
        </div>
        <div className="table-wrap">
          {!readonly && (
            <div className="table-btn-group">
              <Button type="default" size="small" icon={<PlusOutlined />} onClick={addTask} />
              <Button type="default" size="small" danger icon={<MinusOutlined />} onClick={() => delSelected(taskRows, selTask, setTaskRows, setSelTask)} />
              <Button type="default" size="small" icon={<CopyOutlined />} onClick={() => copySelected(taskRows, selTask, setTaskRows, setSelTask)} />
            </div>
          )}
          <table className="detail-table" id="taskTable" style={{ minWidth: 1900 }}>
            <thead>
              <tr>
                {!readonly && (
                  <th style={{ width: 34 }}><input type="checkbox"
                    checked={taskRows.length > 0 && selTask.size === taskRows.length}
                    onChange={() => toggleAll(taskRows, selTask, setSelTask)} /></th>
                )}
                <th style={{ width: 44 }}>序号</th>
                <th>销售订单号</th><th>生产订单号</th><th>公共物料件选择</th>
                <th>规格型号</th><th>生产单批量</th><th>BOM编号</th><th>物料代码</th><th>生产工序</th>
                <th>工序备注</th><th>颜色</th><th>色温</th><th>产品单价</th><th>单价</th>
                <th>完工数量</th><th>金额</th><th>异常金额</th><th>分摊后单价</th><th>分摊后金额</th>
              </tr>
            </thead>
            <tbody>
              {taskRows.map((r, i) => (
                <tr key={r.key}>
                  {!readonly && (
                    <td><input type="checkbox" checked={selTask.has(r.key)}
                      onChange={() => toggleSel(selTask, r.key, setSelTask)} /></td>
                  )}
                  <td>{i + 1}</td>
                  <td><Input size="small" value={r.sale_order_no} disabled={readonly} onChange={e => setTask(i, { sale_order_no: e.target.value })} /></td>
                  <td><Input size="small" value={r.production_order_no} disabled={readonly} onChange={e => setTask(i, { production_order_no: e.target.value })} /></td>
                  <td><Input size="small" value={r.public_material} disabled={readonly} onChange={e => setTask(i, { public_material: e.target.value })} /></td>
                  <td><Input size="small" value={r.specification} disabled={readonly} onChange={e => setTask(i, { specification: e.target.value })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.batch_qty} disabled={readonly} min={0}
                    onChange={v => setTask(i, { batch_qty: v ?? undefined })} /></td>
                  <td><Input size="small" style={{ width: 100 }} value={r.bom_no} disabled={readonly} onChange={e => setTask(i, { bom_no: e.target.value })} /></td>
                  <td><Input size="small" style={{ width: 100 }} value={r.material_code} disabled={readonly} onChange={e => setTask(i, { material_code: e.target.value })} /></td>
                  <td><Input size="small" style={{ width: 90 }} value={r.process} disabled={readonly} onChange={e => setTask(i, { process: e.target.value })} /></td>
                  <td><Input size="small" style={{ width: 110 }} value={r.process_remark} disabled={readonly} onChange={e => setTask(i, { process_remark: e.target.value })} /></td>
                  <td><Input size="small" style={{ width: 90 }} value={r.color} disabled={readonly} onChange={e => setTask(i, { color: e.target.value })} /></td>
                  <td><Input size="small" style={{ width: 90 }} value={r.color_temp} disabled={readonly} onChange={e => setTask(i, { color_temp: e.target.value })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.product_unit_price} disabled={readonly} min={0} precision={2}
                    onChange={v => setTask(i, { product_unit_price: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 90 }} value={r.unit_price} disabled={readonly} min={0} precision={2}
                    onChange={v => setTask(i, { unit_price: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.completed_qty} disabled={readonly} min={0}
                    onChange={v => setTask(i, { completed_qty: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.amount} disabled={readonly} min={0} precision={2}
                    onChange={v => setTask(i, { amount: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.exception_amount} disabled={readonly} min={0} precision={2}
                    onChange={v => setTask(i, { exception_amount: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.allocated_unit_price} disabled={readonly} min={0} precision={2}
                    onChange={v => setTask(i, { allocated_unit_price: v ?? undefined })} /></td>
                  <td><InputNumber size="small" style={{ width: 100 }} value={r.allocated_amount} disabled={readonly} min={0} precision={2}
                    onChange={v => setTask(i, { allocated_amount: v ?? undefined })} /></td>
                </tr>
              ))}
              {taskRows.length === 0 && (
                <tr><td colSpan={readonly ? 19 : 20} style={{ color: '#6b7e9c', padding: 10 }}>暂无任务单，点击 + 添加</td></tr>
              )}
            </tbody>
            {taskRows.length > 0 && (
              <tbody>
                <tr className="sum-row">
                  <td colSpan={readonly ? 19 : 20} style={{ textAlign: 'left', paddingLeft: 10 }}>
                    合计 {taskRows.length} 条任务单 &nbsp;|&nbsp; 批量总计 {taskBatchTotal}
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
