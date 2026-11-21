import type { SettingsValues } from "@link-studio/core";
import { ArrowLeft, Layers3, Puzzle, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdapterManager } from "./adapter-manager";
import { ChannelWorkspace } from "./channel-workspace";
import { SettingsAssistant } from "./settings-assistant";

const errors: Record<string, string> = {
  CHANNEL_HEADERS_INVALID: "请求头名称或值无效，或与系统请求头冲突。",
  CHANNEL_REFERENCED: "请先删除渠道中的模型。",
  CHANNEL_NOT_FOUND: "渠道已删除或不存在，请重新打开模型设置。",
  CHANNEL_TARGET_UNAVAILABLE: "渠道已停用，请启用后再拉取模型。",
  MODEL_CAPABILITIES_INVALID: "能力或参数超出当前协议与模型支持范围。",
  MODEL_ENDPOINT_APPROVAL_REQUIRED: "Vertex AI 凭证地址发生变更，确认地址后才能保存。",
  MODEL_PENDING: "请先设置模型能力和调用协议。",
  MODEL_TRIAL_INPUT_INVALID: "请检查提示词、生成方式、参考素材或参数是否符合模型能力。",
  MODEL_TRIAL_BUSY: "当前渠道已达到生成并发上限。",
  MODEL_TRIAL_TIMEOUT: "模型试跑等待超时。",
  PROVIDER_TEST_FAILED: "模型试跑未成功。",
  PROVIDER_SECRET_STORE_UNAVAILABLE: "系统安全存储不可用，凭证未保存。",
  PROVIDER_SECRET_MISSING: "请先填写此服务的凭证。",
  PROVIDER_CHECK_UNSUPPORTED: "此协议未提供可用的只读连接检查。",
  PROVIDER_CHECK_FAILED: "连接检查失败，请检查渠道地址、凭证和服务权限。",
  PROVIDER_CATALOG_AUTH_FAILED: "服务拒绝读取模型列表，请检查凭证与目录读取权限。",
  PROVIDER_CATALOG_UNSUPPORTED: "此端点没有提供兼容的模型目录，可以手动添加。",
  PROVIDER_CATALOG_INVALID: "服务返回的目录格式不受支持，可以手动添加。",
  PROVIDER_CATALOG_HTTP_FAILED: "获取模型列表失败，请稍后重试或手动添加。",
  PROVIDER_CATALOG_NETWORK_FAILED: "连接模型目录超时或失败，请检查网络与服务端点。",
  PROVIDER_RESPONSE_LIMIT: "服务响应过大，请手动添加需要的模型。",
  PROVIDER_SHARED_CONNECTION: "请在该 Provider 的主配置中修改连接和凭证。",
  PROVIDER_SHARED_ADAPTER: "含多个模型的 Provider 只能切换到同类型的适配器。",
  PROVIDER_DUPLICATE_MODEL: "此模型已添加到当前 Provider。",
  PLUGIN_DISABLED: "此适配器已停用，请在适配器管理中启用。",
  PLUGIN_ACTIVE_REFERENCES: "请先停用引用此适配器的模型。",
  PLUGIN_REFERENCED: "仍有模型引用此版本，无法移除。",
  PLUGIN_BUILTIN_LOCKED: "内置适配器不可移除。",
  PLUGIN_MANIFEST_INVALID: "适配器声明不符合接口规范，请检查能力、鉴权和必要钩子。",
  PLUGIN_SOURCE_LIMIT: "适配器源码超过 512 KiB。",
  PLUGIN_VERSION_DUPLICATE: "已有相同源码的版本。",
  PLUGIN_UPGRADE_INCOMPATIBLE: "目标版本的能力、鉴权或服务地址不兼容。",
  PROVIDER_ENDPOINT_BLOCKED: "目标地址不符合网络授权。请检查协议、地址和本地网络许可。",
  SETTINGS_REVISION_CONFLICT: "配置已更新，请重新载入后再保存。",
  PLUGIN_APPROVAL_REQUIRED: "请核对目标地址和插件版本，确认启用。",
  AGENT_MODEL_INCOMPATIBLE: "小灵需要内置 OpenAI 插件。",
  AGENT_TEST_AUTH_FAILED: "供应商拒绝了请求，请核对服务凭证和模型权限。",
  AGENT_TEST_RATE_LIMITED: "供应商限制了调用频率或额度，请检查账户状态。",
  AGENT_TEST_HTTP_FAILED: "供应商返回错误，请核对服务端点、接口类型和模型名称。",
  AGENT_TEST_NETWORK_FAILED: "无法连接供应商，请检查网络和服务端点。",
  AGENT_TEST_INVALID_STREAM: "未收到完整的流式文本，请检查模型的流式接口支持。",
  AGENT_TEST_TIMEOUT: "等待流式回复超时，请检查网络或供应商状态。",
  AGENT_TEST_BUSY: "此模型的连接检测正在进行。",
  PROVIDER_OUTCOME_UNKNOWN: "请求结果未知，可到供应商控制台核对。",
  AGENT_APPROVAL_STALE: "审批已处理或失效，请查看最新会话状态。",
  AGENT_RUN_BUSY: "当前已有会话正在运行。请返回该会话，或等本轮完成后再发送。",
  AGENT_RUN_STATE_INVALID: "本轮状态已变更。请查看最新会话状态后再操作。",
  AGENT_STATE_UNAVAILABLE: "暂时无法读取会话，请刷新会话状态。",
  AGENT_REQUEST_UNCERTAIN: "暂时无法确认操作结果。请先查看消息或审批状态，再决定是否重试。",
  AGENT_REQUEST_TIMEOUT: "等待操作结果超时。请先查看最新会话状态，再决定是否重试。",
  AGENT_CANVAS_SAVE_REQUIRED: "画布尚未保存。请完成编辑并解决保存冲突，再继续。",
  AGENT_MODEL_BINDING_STALE: "本轮绑定的模型配置已变化，请发送新消息开始下一轮。",
  AGENT_REFERENCE_UNAVAILABLE: "无法读取资料，请使用公开的 HTTPS 纯文本或 Markdown 地址。",
  AGENT_REFERENCE_CHANGED: "链接内容在预览后有更新，请重新预览或移除链接。",
  AGENT_ARGUMENT_INVALID: "消息过长或为空，请调整后重试。",
};

export function settingsError(code: string) {
  return errors[code] ?? `操作失败（${code}）。`;
}

export function SettingsPage({ close, openSkills }: { close: () => void; openSkills: () => void }) {
  const [data, setData] = useState<SettingsValues["list"]>({ providers: [], plugins: [] });
  const [error, setError] = useState("");
  const [managing, setManaging] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const refresh = useCallback(async () => {
    const result = await window.desktop.settings.list({});
    if (!result.ok) {
      setError(settingsError(result.code));
      return undefined;
    }
    setError("");
    setData(result.value);
    return result.value;
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="model-settings" aria-label="模型设置">
      <header className="model-settings-top">
        <button type="button" onClick={close}>
          <ArrowLeft size={17} /> 返回工作区
        </button>
        <h1>{managing ? "适配器管理" : "模型渠道"}</h1>
        <div className="settings-actions">
          <button type="button" onClick={openSkills}>
            <Layers3 size={16} /> 技能管理
          </button>
          <button
            type="button"
            onClick={() => {
              setManaging(!managing);
              setAssistant(false);
            }}
          >
            <Puzzle size={16} /> {managing ? "返回模型渠道" : "适配器管理"}
          </button>
          {!managing && (
            <button
              type="button"
              aria-expanded={assistant}
              onClick={() => setAssistant(!assistant)}
            >
              <Sparkles size={16} /> 设置助手
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="model-notice" role="alert">
          {error}
        </p>
      )}
      {managing ? (
        <AdapterManager data={data} initialHash="" refresh={refresh} />
      ) : (
        <div className="channel-settings-body">
          <ChannelWorkspace data={data} refresh={refresh} />
          {assistant && <SettingsAssistant providers={data.providers} refresh={refresh} />}
        </div>
      )}
    </main>
  );
}
