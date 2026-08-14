import { useState, useEffect } from 'react'
import { Card, Form, Input, Button, Descriptions, Space, Result, Divider, message, Tag, Modal } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/services/api'

interface WecomQrConfig {
    enabled: boolean
    corp_id: string
    agent_id: string
    state: string
}

function WecomBindPanel({ config }: { config: WecomQrConfig }) {
    const [src, setSrc] = useState('')

    useEffect(() => {
        if (!config.enabled || !config.corp_id || !config.agent_id) return
        // 自渲染企微纯二维码页（不引入 @wecom/jssdk，避免桌面端检测）。
        // 扫码确认后顶层跳回 /profile?code=&state=bind，由既有 useEffect 完成绑定。
        const params = new URLSearchParams({
            login_type: 'CorpApp',
            appid: config.corp_id,
            agentid: config.agent_id,
            redirect_uri: `${window.location.origin}/profile`,
            state: 'bind',
            lang: 'zh',
        })
        setSrc(`https://login.work.weixin.qq.com/wwlogin/sso/login?${params.toString()}`)
    }, [config])

    if (!src) return null

    return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
            <iframe src={src} title="企业微信扫码绑定" scrolling="no" style={{ width: 300, height: 400, border: 0 }} />
        </div>
    )
}

export default function Profile() {
    const currentUser = useAuthStore((s) => s.currentUser)
    const updateUserField = useAuthStore((s) => s.updateUserField)
    const [form] = Form.useForm()
    const [pwdForm] = Form.useForm()
    const [saving, setSaving] = useState(false)
    const [pwdSaving, setPwdSaving] = useState(false)
    const [bindLoading, setBindLoading] = useState(false)
    const [unbindLoading, setUnbindLoading] = useState(false)
    const [bindModalOpen, setBindModalOpen] = useState(false)
    const [qrConfig, setQrConfig] = useState<WecomQrConfig | null>(null)
    const [searchParams] = useSearchParams()
    const isInWecom =
        typeof navigator !== 'undefined' &&
        navigator.userAgent.toLowerCase().includes('wxwork')

    if (!currentUser || ('is_share_user' in currentUser)) {
        return (
            <Result
                status="403"
                title="个人中心仅对登录用户开放"
                subTitle="分享访问账号无法管理个人资料。"
            />
        )
    }

    const user = currentUser
    const isSupplier = user.role_code === 'supplier'

    const onFinish = async (values: { display_name: string }) => {
        const name = (values.display_name || '').trim()
        if (!name) {
            form.setFields([{ name: 'display_name', errors: ['显示姓名不能为空'] }])
            return
        }
        setSaving(true)
        try {
            await authApi.updateProfile(name)
            updateUserField({ display_name: name })
            message.success('个人资料已更新')
        } catch {
            // 错误提示由 axios 拦截器统一处理
        } finally {
            setSaving(false)
        }
    }

    const handleChangePassword = async () => {
        try {
            const values = await pwdForm.validateFields()
            setPwdSaving(true)
            await authApi.changePassword(values.old_password, values.new_password)
            message.success('密码修改成功')
            pwdForm.resetFields()
            updateUserField({ is_default_password: false })
        } catch {
            // 表单校验错误或接口错误均已提示
        } finally {
            setPwdSaving(false)
        }
    }

    const handleBindWecom = async () => {
        if (isInWecom) {
            // 企微客户端内：OAuth 静默授权，回跳 /profile?code=xxx&state=bind 后自动绑定
            setBindLoading(true)
            try {
                const res: any = await authApi.wecomBindUrl()
                const url = res?.data?.oauth_url
                if (url) window.location.href = url
            } catch {
                // 错误提示由 axios 拦截器统一处理
            } finally {
                setBindLoading(false)
            }
            return
        }
        // PC 浏览器：弹出企微扫码面板
        let cfg = qrConfig
        if (!cfg) {
            try {
                const res: any = await authApi.wecomQrConfig()
                cfg = (res?.data ?? null) as WecomQrConfig | null
                setQrConfig(cfg)
            } catch {
                return
            }
        }
        if (!cfg || !cfg.enabled || !cfg.corp_id || !cfg.agent_id) {
            message.warning('企业微信未配置，暂无法绑定')
            return
        }
        setBindModalOpen(true)
    }

    const handleUnbindWecom = async () => {
        setUnbindLoading(true)
        try {
            await authApi.wecomUnbind()
            updateUserField({ wecom_user_id: null })
            message.success('企业微信已解绑')
        } catch {
            // 错误提示由 axios 拦截器统一处理
        } finally {
            setUnbindLoading(false)
        }
    }

    // 企微 OAuth 回跳：/profile?code=xxx&state=bind → 自动完成绑定
    useEffect(() => {
        const code = searchParams.get('code')
        const state = searchParams.get('state')
        if (!code || state !== 'bind') return
        ;(async () => {
            try {
                const res: any = await authApi.wecomBind(code)
                updateUserField({ wecom_user_id: res?.data?.wecom_user_id ?? null })
                message.success('企业微信绑定成功')
            } catch {
                // 错误提示由 axios 拦截器统一处理
            } finally {
                window.history.replaceState({}, '', '/profile')
            }
        })()
    }, [searchParams, updateUserField])

    return (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Card title="基本信息" bordered={false}>
                <Descriptions column={1} size="small" labelStyle={{ width: 120 }}>
                    <Descriptions.Item label="用户名">{user.username}</Descriptions.Item>
                    <Descriptions.Item label="角色">{user.role_name}</Descriptions.Item>
                    {user.position_name && (
                        <Descriptions.Item label="岗位">{user.position_name}</Descriptions.Item>
                    )}
                    {user.supplier_name && (
                        <Descriptions.Item label="供应商">{user.supplier_name}</Descriptions.Item>
                    )}
                </Descriptions>
            </Card>

            <Card title="编辑资料" bordered={false}>
                <Form
                    form={form}
                    layout="vertical"
                    initialValues={{ display_name: user.display_name || '' }}
                    style={{ maxWidth: 420 }}
                    onFinish={onFinish}
                >
                    <Form.Item
                        name="display_name"
                        label="显示姓名"
                        rules={[
                            { required: true, message: '请输入显示姓名' },
                            { max: 50, message: '不超过50个字符' },
                        ]}
                    >
                        <Input placeholder="请输入显示姓名" maxLength={50} showCount />
                    </Form.Item>
                    <Form.Item>
                        <Button type="primary" htmlType="submit" loading={saving}>
                            保存
                        </Button>
                    </Form.Item>
                </Form>
            </Card>

            <Card title="账户安全" bordered={false}>
                <Form
                    form={pwdForm}
                    layout="vertical"
                    style={{ maxWidth: 420 }}
                >
                    <Form.Item name="old_password" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
                        <Input.Password placeholder="输入当前密码" />
                    </Form.Item>
                    <Form.Item name="new_password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '密码至少6位' }]}>
                        <Input.Password placeholder="至少6位" />
                    </Form.Item>
                    <Form.Item
                        name="confirm_password"
                        label="确认新密码"
                        dependencies={['new_password']}
                        rules={[
                            { required: true, message: '请确认新密码' },
                            ({ getFieldValue }) => ({
                                validator(_, value) {
                                    if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                                    return Promise.reject(new Error('两次密码不一致'))
                                },
                            }),
                        ]}
                    >
                        <Input.Password placeholder="再次输入新密码" />
                    </Form.Item>
                    <Form.Item>
                        <Button type="primary" onClick={handleChangePassword} loading={pwdSaving}>
                            修改密码
                        </Button>
                    </Form.Item>
                </Form>

                {!isSupplier && (
                    <>
                        <Divider />
                        <Space direction="vertical" size="middle">
                            <div>
                                <span style={{ marginRight: 8, fontWeight: 500 }}>企业微信绑定</span>
                                {user.wecom_user_id ? (
                                    <Tag color="green">{user.wecom_user_id}</Tag>
                                ) : (
                                    <Tag>未绑定</Tag>
                                )}
                            </div>
                            <div style={{ color: '#64748b', fontSize: 13 }}>
                                绑定后可一键登录本系统；换绑需要扫描新的企业微信授权。
                            </div>
                            <Space>
                                <Button
                                    type="primary"
                                    loading={bindLoading}
                                    onClick={handleBindWecom}
                                >
                                    {user.wecom_user_id ? '换绑企业微信' : '绑定企业微信'}
                                </Button>
                                {user.wecom_user_id && (
                                    <Button danger loading={unbindLoading} onClick={handleUnbindWecom}>
                                        解绑
                                    </Button>
                                )}
                            </Space>
                        </Space>
                    </>
                )}
            </Card>

            <Modal
                title="扫码绑定企业微信"
                open={bindModalOpen}
                footer={null}
                onCancel={() => setBindModalOpen(false)}
                width={380}
            >
                <div style={{ marginBottom: 12, color: '#64748b', fontSize: 13 }}>
                    使用企业微信 App 扫码，确认身份后即可完成绑定。
                </div>
                {qrConfig && qrConfig.enabled && (
                    <WecomBindPanel config={qrConfig} />
                )}
            </Modal>
        </Space>
    )
}
