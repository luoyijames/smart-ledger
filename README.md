# 智能记账 (Smart Ledger) v1.0.1

纯本地、离线优先的个人人民币记账 PWA 应用。

所有数据仅保存在本机浏览器 IndexedDB，**不会上传到任何服务器**。

## 在线预览 / 使用

1. 打开仓库：https://github.com/luoyijames/smart-ledger
2. 启用 GitHub Pages（Settings → Pages → Source: Deploy from a branch → main / root）后访问：
   - `https://luoyijames.github.io/smart-ledger/`
3. 或直接下载整个仓库，用本地静态服务器打开（如 `npx serve .`）。

在 iPhone Safari 中打开后，点「分享」→「添加到主屏幕」即可像 App 一样使用。

## 功能

- 记支出 / 记收入（手动）
- 导入微信、支付宝、银行卡账单（CSV / Excel .xlsx）
- 智能分类（本地关键词 + 用户规则学习）
- 预算管理与超支提醒
- 统计图表、消费习惯分析
- 导出 CSV / JSON 备份、从备份恢复
- 类别管理、主题切换（浅色/深色/跟随系统）
- Service Worker 离线缓存

## 文件结构

```
index.html          # 主页面壳
style.css           # 样式
app.js              # 界面与业务逻辑
lib.js              # 工具、IndexedDB、分类、账单解析
sw.js               # Service Worker
manifest.webmanifest # PWA 配置
icons/              # 图标（可选，用于安装到主屏幕）
```

## 隐私说明

- 数据只存在你的设备上
- 无账号、无网络请求（除首次加载静态资源）
- 定期使用「设置 → 备份全部数据」导出 JSON 到「文件」App

## 版本

v1.0.1
