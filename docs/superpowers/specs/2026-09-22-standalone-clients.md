# 独立会议客户端

用户确认：Windows EXE、Android APK 不依赖原服务器；允许 Cloudflare Worker 负责信令和短期 TURN 凭据。媒体仅使用 WebRTC P2P 或 Cloudflare TURN，禁止 LiveKit/coturn 回退。

新增 apps/standalone，共享本地网页与 WebRTC mesh 核心，Windows Electron 封装，Android 原生 WebView 封装。沿用项目配色与语音/单人屏幕共享范围；Android 是语音和观看端。每房最多 5 人。Windows 通过原生选择框选择屏幕/窗口并选择是否共享系统声音。

Cloudflare Worker + 每房一个 Durable Object 管理创建、入会、成员、单人共享锁、主持人结束会议和 offer/answer/ICE 转发。房间码是随机 128 位邀请凭据；用户令牌独立，主持人权限不能由客户端自报。房间 24 小时到期，连接断开后允许短时间凭令牌重连。校验消息大小、速率、目标成员和 SDP；凭据接口仅对成员开放并缓存短期 Cloudflare 凭据。长期 Cloudflare 密钥仅保存在 Worker secrets。

客户端内置资源，无外部网页依赖；首次配置 HTTPS Worker 地址，可通过邀请 JSON 一并分享地址和房间码。信令故障时提示并重连，不静默切换媒体服务。ICE 重启前刷新凭据。显示实际 P2P/TURN 路径。

保留当前工作区已有修改。交付本地 EXE、已签名 APK、Worker 源码与部署说明，记录自动测试、打包校验及实际设备测试边界。没有账号权限时仍交付可配置 Worker 地址的安装包，明确未经线上端到端验证。
