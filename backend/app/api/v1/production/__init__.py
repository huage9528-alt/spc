from fastapi import APIRouter

from app.api.v1.production.front_process import router as front_process_router
from app.api.v1.production.smt import router as smt_router
from app.api.v1.production.lean import router as lean_router
from app.api.v1.production.assembly import router as assembly_router
from app.api.v1.production.packaging import router as packaging_router
from app.api.v1.production.overview import router as overview_router
from app.api.v1.production.kpi_summary import router as kpi_summary_router
from app.api.v1.production.process_exceptions import router as exceptions_router
from app.api.v1.production.schedule_plans import router as schedule_plans_router
from app.api.v1.production.product_process_capacities import router as product_process_capacities_router
from app.api.v1.production.upph_formula_configs import router as upph_formula_configs_router

router = APIRouter()

router.include_router(overview_router, prefix="/overview", tags=["生产总览"])
router.include_router(kpi_summary_router, prefix="/kpi-summary", tags=["372驾驶舱KPI"])
router.include_router(schedule_plans_router, prefix="/schedule-plans", tags=["计划排产"])
router.include_router(product_process_capacities_router, prefix="/product-process-capacities", tags=["产品工序产能"])
router.include_router(upph_formula_configs_router, prefix="/upph-formula-configs", tags=["UPPH配置"])
router.include_router(front_process_router, prefix="/front-process", tags=["前道管理"])
router.include_router(smt_router, prefix="/smt", tags=["贴片管理"])
router.include_router(lean_router, prefix="/lean", tags=["精益管理"])
router.include_router(assembly_router, prefix="/assembly", tags=["组装管理"])
router.include_router(packaging_router, prefix="/packaging", tags=["包装管理"])
router.include_router(exceptions_router, prefix="/exceptions", tags=["工序异常池"])
