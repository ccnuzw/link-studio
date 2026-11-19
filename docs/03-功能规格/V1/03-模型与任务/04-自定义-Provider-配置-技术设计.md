---
title: "04 自定义 Provider 配置 - 技术设计"
version: V1
feature_id: V1-FR-004
updated: 2026-11-19
---
# 04 自定义 Provider 配置 - 技术设计

来源：[需求](04-自定义-Provider-配置.md#需求说明) · [接口](04-自定义-Provider-配置.md#接口契约) · [数据](04-自定义-Provider-配置.md#数据与事务) · [验收](04-自定义-Provider-配置.md#验收标准)

## 风险与对策

| 风险 | 严重程度 | 对策 | 关联决策 |
| --- | --- | --- | --- |
| 密钥出现在 Renderer/log | 高 | Main 持有 secret；脱敏测试；只返回 hasSecret | D002、D005 |
| Provider endpoint 滥用访问内网 | 高 | URL scheme/host 策略和请求重定向重新校验 | D004 |
| 插件恶意执行 | 高 | 插件沙箱纯钩子，宿主持有网络与 Secret，启用需用户批准 | D005 |
| safeStorage 不可用 | 高 | 拒绝明文降级；保存策略显式提示 | D002 |

## 单元契约

| 函数 | 前置条件 | 返回 / 后置条件 | 副作用 | 幂等 |
| --- | --- | --- | --- | --- |
| `validatePlugin(source)` | source 大小/类型符合要求 | 返回 API 兼容、钩子和能力报告 | 启动受限校验器 | 以源码 hash 幂等 |
| `approvePlugin(pluginId, hash)` | 用户查看对应源码/hash | approval 绑定精确版本 | 写入批准记录 | hash 绑定 |
| `executePluginHook(pluginId, hook, context)` | 插件已批准/启用 | 返回受限 JSON 描述 | 运行隔离钩子 | 按 job/call ID 幂等 |
| `saveProvider(input, revision)` | 插件版本有效、端点符合策略 | 安全保存配置，仅返回脱敏 profile | 原子更新 profile 和 secretRef | revision CAS |

## 伪代码

```text
FUNCTION enablePlugin(pluginId, sourceHash, approval):
  IF plugin manifest/hooks invalid: RETURN PLUGIN_INVALID       // B04-01
  IF approval missing OR approval.hash != sourceHash: RETURN APPROVAL_REQUIRED // B04-02
  IF sandbox unavailable: RETURN SANDBOX_UNAVAILABLE            // B04-03
  run pure hook in isolated runtime with limits                  // B04-04
  IF hook output violates schema: RETURN PLUGIN_OUTPUT_INVALID  // B04-05
  persist enabled version and emit audit event                  // B04-06

FUNCTION saveProvider(input, revision):
  IF endpoint violates network policy: RETURN PROVIDER_ENDPOINT_BLOCKED // B04-07
  IF secret input exists AND secure storage unavailable: RETURN PROVIDER_SECRET_STORE_UNAVAILABLE // B04-08
  write new secretRef, atomically replace profile using revision // B04-09
  IF profile commit fails: clean new secretRef; retain old profile // B04-10
  remove obsolete secret after commit; return redacted profile  // B04-11
```

## 分支到测试追踪

| 分支 | 功能 AC | 跨功能验收 / NFR |
| --- | --- | --- |
| B04-01 | AC01 | - |
| B04-02 | AC06 | - |
| B04-03～05 | AC05 | V1-NFR-001 |
| B04-06 | AC02、AC06 | V1-NFR-001、V1-E2E-01 |
| B04-07 | AC03 | V1-NFR-001 |
| B04-08 | AC04 | V1-NFR-001 |
| B04-09～11 | AC02、AC04 | V1-NFR-001 |

## 并发控制

同一插件版本启用/禁用使用 compare-and-swap；Agent 修改已批准插件会产生新草稿 hash，旧批准不能复用。Provider 配置并发更新使用 revision。

## 事务边界

安全存储与 JSON profile 不支持共同事务。建议先写新 secretRef，再原子 profile 更新，成功后删除旧 secret；profile 更新失败时清理新 secret。细节需平台验证。

## 幂等与重试

providerId 对配置更新幂等；连接测试为只读请求，但供应商可能产生调用费用，应在 UI 告知并限制频率。

## 外部调用与补偿

连接测试与真实调用均由 Host 执行受限 Request Descriptor：插件钩子只构造请求描述和解析响应，不持有网络/文件/定时器/进程 API。Host 对 URL、DNS/IP、redirect、协议、请求/响应大小及超时执行策略；凭证仅在 Host 注入请求，不传给插件钩子。API 契约、内置插件与用户插件使用同一版本兼容检查。

## 安全与日志

- 采用 Electron safeStorage；如其平台保护级别不可用，拒绝密钥写入，确切策略待决。
- endpoint 防止 scheme downgrade、redirect 到未许可 host、DNS rebinding 和 credential forwarding。
- 沙箱不暴露 Node.js、`require`、文件、网络、定时器、环境变量和子进程；限制源码大小、执行时间、内存/输出体积。
- localhost/private LAN 仅在用户明确授权本地端点后开放；云 metadata 地址始终拒绝。
- 手工输入后的 Secret 由 Main/Host 管理，仅在发请求时注入，不传给插件脚本或 Agent；不在后续响应中回传 Renderer。
- Agent 可读取已授权的 API 文档/样例并创建草稿；启用批准绑定源码 hash，内容变化后批准失效。

## 发布与回滚

凭证 schema 迁移必须可以识别旧版本；升级失败保留旧 secretRef，不输出密钥恢复文件。

## 变更记录

| 日期 | 变更 | 关联决策 |
| --- | --- | --- |
| 2026-11-19 | 初始 Draft | D002、D004、D005 |
