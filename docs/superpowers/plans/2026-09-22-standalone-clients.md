# Standalone Clients Implementation Plan

**Goal:** 生成不依赖原服务器的 Windows EXE 和 Android APK。
**Architecture:** 本地资源 + mesh WebRTC；Cloudflare Worker/Durable Object 仅信令和 TURN 凭据。
**Tech Stack:** JavaScript、Electron、Android Java WebView、Cloudflare Workers。
**Spec:** ../specs/2026-09-22-standalone-clients.md

用户已明确授权实现及 Cloudflare Worker 方案。本轮直接实现并验证，不重复请求实现授权。

## Global Constraints
- 不访问原 API、LiveKit、coturn；不将 Cloudflare 长期密钥放进包。
- 最多 5 人，单人屏幕共享；Android 语音和观看。
- 保留已有未提交修改。

## Review Focus
- 重连后的身份和共享锁；陌生成员不能伪造主持人。
- 并发 offer、早到 ICE、共享停止后残留画面。
- 麦克风拒绝、自动播放限制和 Android 权限撤回。
- 凭据到期及网络切换，不回退原服务器。
- 安装包本地资源、签名与首次 Worker 配置。

## Tasks
- [ ] 1. 新增 apps/standalone/test 协议测试（邀请验证、角色、人数、消息限流、共享锁），运行 node --test 观察失败；实现 worker 协议并通过测试。
- [ ] 2. 实现 worker/index.js：房间持久化、WebSocket 身份绑定、凭据缓存、到期清理；假存储/套接字集成测试覆盖越权与断线。
- [ ] 3. 实现共享网页客户端：入会、麦克风、完美协商、屏幕共享、重连、路径诊断；浏览器双端假媒体端到端验证。
- [ ] 4. Electron main/preload：本地安全来源、屏幕选择、麦克风权限；构建便携 EXE 并启动检查。
- [ ] 5. Android Activity：本地 HTTPS 资源、麦克风运行时权限、生命周期退出清理；SDK 工具编译签名 APK 并验证包内容。
- [ ] 6. Worker 部署配置和中文使用说明；完整测试、制品 SHA256、独立审查和交付。
