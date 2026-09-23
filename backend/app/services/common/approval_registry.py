"""审批中心 - 待审批提供者注册表。

新业务流程接入统一「待我审批」列表时，只需在 approval_providers.py 里注册一个
provider（biz_type + 名称 + 归一化取数函数），审批中心 API 自动聚合，无需改本模块。
可选能力（已审批 / 我发起的 / 预览 / 动作）按需补齐：未实现的端点会返回「不支持」，
不影响待办聚合。
"""

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from sqlalchemy.ext.asyncio import AsyncSession

# 取数签名：(db, username, role_code) -> 归一化待审批条目列表（各 biz 内部自行按节点权限过滤）
PendingFetcher = Callable[[AsyncSession, str, str], Awaitable[list[dict]]]
# 个人维度取数（我已审批 / 我发起的）：(db, username) -> 归一化条目列表
MyFetcher = Callable[[AsyncSession, str], Awaitable[list[dict]]]
# 抽屉详情：(db, username, role_code, entity_id) -> 预览数据（含 fields/progress/logs/can_act）
PreviewFetcher = Callable[[AsyncSession, str, str, int], Awaitable[Optional[dict]]]


@dataclass(frozen=True)
class ApprovalActionRequest:
    """统一审批动作入参（超过 3 个参数收拢为对象，避免长签名）。"""

    entity_id: int
    approver: str
    approver_role: str
    comment: str = ""
    expected_version: Optional[int] = None


ActionHandler = Callable[[AsyncSession, ApprovalActionRequest], Awaitable[dict]]


@dataclass(frozen=True)
class ApprovalPendingProvider:
    biz_type: str
    biz_name: str
    fetch: PendingFetcher
    fetch_approved: Optional[MyFetcher] = None
    fetch_submitted: Optional[MyFetcher] = None
    preview: Optional[PreviewFetcher] = None
    approve: Optional[ActionHandler] = None
    reject: Optional[ActionHandler] = None
    condition_field_options: list[dict] = field(default_factory=list)


_providers: dict[str, ApprovalPendingProvider] = {}


def register_pending_provider(provider: ApprovalPendingProvider) -> None:
    _providers[provider.biz_type] = provider


def get_pending_providers() -> list[ApprovalPendingProvider]:
    return list(_providers.values())


def get_provider(biz_type: str) -> Optional[ApprovalPendingProvider]:
    return _providers.get(biz_type)
