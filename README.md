## 主要功能：  
* 自动破解网页禁止复制、禁止选中文本的限制
* 选中文本自动复制（可配置为手动复制）
* 支持单个网站自定义配置是否自动复制
* 剪贴板历史记录管理（查看、搜索、置顶、删除）
* 复制成功提示语位置可拖动调整并记忆，支持自定义配色
* Google Drive 云同步功能
  - 支持多设备间同步剪贴板历史
  - 自动数据校验和完整性检查
  - 智能合并和替换选项
  - 支持手动备份和恢复
* 支持历史记录智能合并和替换选项
* 支持快捷键操作（Ctrl+Shift+X 复制整页内容）
* 支持双击导出内容为 TXT 文件
* 支持国际化（中文、英文）
* 支持右键菜单快速开启/关闭自动复制

## 技术特性：
* 智能的连接管理和自动重连机制
  - 自动检测连接状态
  - 断线自动重连
  - 多标签页并发处理
  - 完善的生命周期管理
* 数据完整性校验和安全保护
  - 云同步数据校验
  - 本地存储限制
  - 数据备份机制
* 支持大文本分段处理和长度限制
  - 单条记录最大50000字符
  - 历史记录最多保存500条
  - 智能的清理机制
* 自适应的错误处理和用户友好提示
  - 详细的错误提示
  - 操作状态反馈
  - 进度显示
* 针对特定网站的优化处理（如百度文库等）
* 支持后台服务持久化运行
* 使用固定的扩展ID,保证在不同设备上安装后ID保持一致,方便数据同步

## 声明⚠️
本项目完全开源免费，仅用于研究学习，请勿用于非法用途，否则一切后果自行承担。

作者：许文婷  
邮箱：andy@590.net

## 更新日志： 
### 2.2.0
* 修复了OAuth2认证失败的问题,现在可以正常使用Google Drive同步功能了

### 2.1.0
* 新增 Google Drive 云同步功能
  - 支持多设备间剪贴板历史同步
  - 使用了Google Drive API实现云同步,需要在[Google Cloud Platform控制台](https://console.cloud.google.com/)中创建OAuth2客户端并配置
  - 提供智能合并和替换选项
  - 自动数据校验和完整性检查
* 优化连接管理
  - 改进重连机制和超时处理
  - 增加连接状态监控
  - 优化错误恢复策略
* 改进用户体验
  - 添加进度提示和状态反馈
  - 优化错误提示信息
  - 支持双击导出内容
* 提升稳定性
  - 增强异常处理机制
  - 优化数据存储逻辑
  - 改进页面生命周期管理

### 0.11.0
* 增加右键菜单可选项配置
* 优化界面交互体验
* 修复已知问题 