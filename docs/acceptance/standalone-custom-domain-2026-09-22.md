# 独立客户端自定义域名

用户授权将新子域名 p2p.babagan.cloud 绑定到现有 babagan-p2p Worker。

变更前通过 Cloudflare DNS 控制台确认仅有主域名、meet、rtc、turn 四条 A 记录，均为 8.162.24.2 / DNS only，没有 p2p 或通配记录。通过官方 Workers Domains API 新增 p2p 自定义域名，响应 success=true、enabled=true、service=babagan-p2p、environment=production，并返回证书 ID。未编辑原四条记录。

验证：Node HTTPS /health 返回 200，service=babagan-p2p、turnConfigured=true；线上集成测试通过创建、加入、WebSocket、身份绑定、权限校验和 Cloudflare 临时 TURN 凭据。首次 Windows curl 因证书吊销检查网络不可达失败，未关闭证书校验；Node 标准 TLS 验证请求成功。

现有 1.0.0 EXE/APK 未在此次域名配置中重新打包，需在“连接设置”将 Worker 地址改为 https://p2p.babagan.cloud，然后创建新会议并发送新邀请。仅修改连接设置不会重写旧邀请内的 workers.dev 地址。

源码默认地址已更新，Wrangler 配置已记录 custom_domain 路由，以保留后续部署配置。原 workers.dev 入口继续可用。

上述验证使用当前电脑网络，不能视为国内无 VPN 实网验收；没有切换用户 VPN 或系统代理设置。
