"""对外接口实现集合

新增一个对外接口只需：
1. 在本目录下新建文件（或加到现有文件）
2. 用 @register_external 装饰一个 async handler
3. 本包 __init__.py 已 import 全部子模块，自动注册
"""

# 导入各业务对外接口模块，确保 @register_external 装饰器执行
from . import orders  # noqa: F401
from . import bom  # noqa: F401
from . import bom_detail  # noqa: F401
from . import bom_tree  # noqa: F401
from . import masterdata  # noqa: F401
from . import purchase  # noqa: F401
from . import production  # noqa: F401
from . import human_resources  # noqa: F401
from . import inventory  # noqa: F401
from . import warehouse  # noqa: F401
from . import production_task_orders  # noqa: F401
from . import process_data  # noqa: F401
from . import material_kitting  # noqa: F401
from . import inventory_availability  # noqa: F401
from . import material_supplies  # noqa: F401

