"""对外接口共享模型与类型"""

from typing import Generic, List, Optional, TypeVar

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator
from typing_extensions import Annotated

T = TypeVar("T")


class ExternalPage(BaseModel, Generic[T]):
    """对外分页响应（与现有 data 结构逐字段一致；不得用 PageResult，它多一个 stats 字段）"""
    items: List[T] = Field(..., description="当前页数据")
    total: int = Field(..., description="总条数")
    page: int = Field(..., description="当前页码")
    page_size: int = Field(..., description="每页条数")


class ExternalQuery(BaseModel):
    """对外接口 query 参数基类

    - 空字符串按未传处理（?page= 与不传 page 行为一致，兼容现状；
      ""->None 对 Optional[str] 字段与 if x: 判断等价，安全）
    - 忽略未声明的多余 query 参数（兼容 catch-all 时代的静默接受）
    - 字段一律 Optional + None 默认，handler 内做与旧代码相同的兜底
    """
    model_config = ConfigDict(extra="ignore")

    @field_validator("*", mode="before")
    @classmethod
    def _empty_to_none(cls, v):
        if isinstance(v, str) and v == "":
            return None
        return v


class PageParamsMixin(ExternalQuery):
    """分页参数（所有列表接口共用）"""
    page: Optional[int] = Field(None, description="页码，默认 1")
    page_size: Optional[int] = Field(None, description="每页条数，默认 20，最大 200")


def _split_csv_int(v):
    """'1,0' -> [1, 0]；'' / None -> None；非法 -> ValueError（FastAPI 转 422）"""
    if v is None or v == "":
        return None
    if isinstance(v, str):
        parts = [p.strip() for p in v.split(",") if p.strip() != ""]
        if not parts:
            return None
        try:
            return [int(p) for p in parts]
        except ValueError:
            raise ValueError("该参数需为逗号分隔的整数，如 1,0")
    return v


IntCsv = Annotated[Optional[List[int]], BeforeValidator(_split_csv_int)]
"""逗号分隔整数列表 query 参数：'1,0' -> [1, 0]"""
