# 独立客户端构建与验收

## 范围

- 新增 `apps/standalone`，保留原工作区未提交修改。
- Windows 10/11 x64 便携 EXE；Android 8.0+ 已签名 APK。
- 本地资源 + WebRTC mesh；唯一媒体中继是 Cloudflare TURN。
- Worker: `babagan-p2p.1312479965.workers.dev`。
- Durable Object: `MeetingRoom`，SQLite migration v1。
- TURN 应用：`babagan-p2p-native-20260922`。两个长期凭据均为 Worker Secret，无明文写入源码或安装包。

## 已完成的验证

- 11 个 Node 测试通过：邀请和 HTTPS 地址、消息伪造、ICE 地址白名单、5 人限制、主持人权限、共享锁、离线席位、恢复定时器。
- 新增源码 ESLint 通过。
- 本地真实 workerd/WebSocket 集成测试通过。
- 线上 Worker 创建、入会、真实 WebSocket 转发、发送者身份绑定、越权拒绝及临时 TURN 凭据获取通过。
- 两个 Chromium 客户端在强制 relay 模式下显示实际 `Cloudflare TURN` 候选对；合成音频轨道、静音同步、合成屏幕解码、共享锁、停止共享、重连、主持人结束通过。
- 390px 窄屏无横向溢出，桌面与移动布局截图在 output/standalone。
- Electron 源码和已打包内部 EXE 均通过：本地安全来源、renderer 无 Node require、模拟麦克风、线上创建和结束会议。
- APK v2/v3 签名校验通过，manifest 的启动 Activity、SDK 26/35、麦克风/网络权限已检查。

## 修复记录

- 首次协商双方预建空 video transceiver 导致屏幕轨道对应错误：改为固定一方创建 transceiver，另一方复用远端 offer 中的轨道槽。
- 短时断网恢复后取消的定时器未清空：独立审查发现，新增回归测试观察失败，再清空 timer 并通过测试。
- workerd 对提前返回的请求体读取错误：入口限长读取后再转发。
- Electron 测试命令的目录末尾反斜杠导致 Windows 把后续参数并入路径：测试使用规范化目录，已复测源码及打包内部 EXE。
- 原工作区路径中的原生资源写入/文件锁错误：改用全新临时目录构建 EXE。

## 验证边界

没有连接 Android 真机，因此 APK 未完成真机安装、扬声器/蓝牙路由和权限撤回测试。Windows 媒体测试使用合成麦克风与屏幕，真实屏幕选择/系统声音采集、跨运营商网络和 5 人长时带宽稳定性不在已通过声明内。EXE 未进行商业 Authenticode 签名。

## 产品差异

独立入口保留语音、单人屏幕共享、静音、邀请、离开/结束、路径诊断与重连。没有迁移原网页管理员密码、踢人/共享授权和手工编码码率面板。Android 沿用手机作为语音和观看端的范围，并明确前台使用限制。
