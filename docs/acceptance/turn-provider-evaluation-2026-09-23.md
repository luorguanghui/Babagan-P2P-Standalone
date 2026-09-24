# 独立客户端 TURN 路径诊断与候选服务评估

日期：2026-09-23。目标：解释强制 Cloudflare TURN 后动态屏幕共享降到约 0.1 Mbps 量级，并评估主要在中国大陆使用时的替代中继。没有切换生产 TURN 提供方，也没有创建第三方账号。

## 当前客户端的受控测试

使用 `apps/standalone/test/turn-diagnostic.mjs`，两页 Chrome、Cloudflare Worker 短期凭据和 1280×720/30fps 持续变化的合成画面。数据为此 Windows 环境的短时样本，不能代表所有参与者网络。

| 路径 | 观察到的视频发送 | 观察到的情况 |
| --- | --- | --- |
| 本机直连 | 约 2.0–2.2 Mbps | 约 30fps、RTT 约 0–1ms |
| Cloudflare TURN/UDP | 持续约 0.03–0.07 Mbps | RTT 多次达到 350–1300ms，浏览器可用带宽估计约 0.13–0.19 Mbps，发送上限仍有 0.50 Mbps |
| Cloudflare TURN/TCP | 初期约 0.15 Mbps，随后约 0.03 Mbps | 可用带宽估计降至约 0.13 Mbps |
| Cloudflare TURN/TLS | 持续约 0.03–0.06 Mbps | 高 RTT、带宽受限 |

同一机器上的另一组独立 relay-to-relay DataChannel 测试，在请求 0.25/1/2 Mbps 时确认接收约 0.11–0.12 Mbps，发送队列持续积压。它不经过屏幕编码，也没有使用应用的画质控制，因此本次现象无法只靠抬高 `maxBitrate` 解决。

本机启用 `Mihomo Meta Tunnel`；系统把 `turn.cloudflare.com`、`stun.cloudflare.com` 和项目域名解析成 `198.18.x.x` fake-IP。单次隔离试验将 TURN UDP URL 的主机名替换为 Cloudflare 官方公开的真实地址后，视频短时提高到约 0.5 Mbps，但独立数据通道未出现同等改善。因此代理配置是明确的混杂因素，尚不能断言它是全部原因，也不能据此比较其他提供方。在购买或迁移前，应于双方客户端分别让 TURN 域名走直连并复测。

Cloudflare [TURN 文档](https://developers.cloudflare.com/realtime/turn/) 与 [FAQ](https://developers.cloudflare.com/realtime/turn/faq/) 明确说明 Realtime TURN 不运行于其 China Network，中国大陆流量会连接境外节点。Cloudflare TURN 不支持指定中国大陆中继区域；仅更换 UDP/TCP/TLS 在本环境未解决问题。

## 候选与试测顺序

| 候选 | 可用区域与接入 | 试测价值与限制 |
| --- | --- | --- |
| [火山引擎 WTN TURN](https://www.volcengine.com/docs/6752/1263661) | [官方列出大陆廊坊接入](https://www.volcengine.com/docs/6752/1338564)；接口返回标准 `ice_servers` | 地理位置最贴合大陆用户。TURN 功能需要联系技术支持开通，公开文档不足以确认本项目费用，先取试用资格和报价。 |
| [Xirsys](https://xirsys.com/status) | 官方状态页列出香港、东京和新加坡 TURN；[FAQ](https://xirsys.com/faq) 称新账号前 30 天可使用全部 12 个区域 | 最方便先做香港节点实际对照。试用后继续使用全区域需付费；尚无本项目链路测速或明确价格结论。 |
| [Twilio Network Traversal](https://www.twilio.com/docs/stun-turn/api) | 官方支持固定到[东京或新加坡](https://www.twilio.com/docs/stun-turn/regions)；按流量计费 | 可作为第二个境外服务对照，但没有文档确认中国大陆或香港 TURN 节点；[亚洲公开价格](https://static0.twilio.com/en-us/voice/pricing/us)为约 US$0.60/GB，实际以购买页面为准。 |
| [Metered](https://www.metered.ca/docs/turnserver-guides/turnserver-regions/) | 付费计划可固定日本、新加坡、亚洲东等节点 | 免费计划仅给 Standard 节点，不能直接验证指定亚洲节点；[Growth 计划](https://www.metered.ca/pricing)公开为 US$99/月含 150GB，因此当前优先级较低。 |

以上为产品能力与试测顺序，不是已验证的速度排名。主要在大陆时优先比较大陆廊坊与香港，再根据实际运营商结果考虑东京/新加坡。P2P 保持优先，TURN 只为无法直连的连接提供兜底；第三方长期 API 凭据只能保存在 Worker Secret，不进入 EXE/APK。

## 统一验收方法

1. 在共享端与接收端分别确认代理对 TURN 域名的规则，记录是否直连、所选 relay 协议和 RTT。
2. 同一段 720p30 动态画面、两台真实设备、至少两种大陆运营商网络，分别强制 Cloudflare 与候选 TURN。记录发送/接收 Mbps、分辨率、帧率、丢包、RTT 和 5–10 分钟稳定性。
3. 临时凭据可写入工作区外、仅当前用户可读的 JSON 文件，格式为 `[{"urls":["turn:relay.example:3478?transport=udp"],"username":"临时用户名","credential":"临时密码"}]`。设置 `TURN_ICE_SERVERS_FILE` 后运行 `apps/standalone/test/turn-diagnostic.mjs`；脚本覆盖 ICE 响应，仅用于本地试测。不得把长期密钥、临时凭据或含凭据的日志提交到仓库。
4. 只有候选在所需运营商组合下明显优于 Cloudflare，才将它接入 Worker 的短期凭据接口并打包客户端；故障时保留 Cloudflare 作为最后兜底。
