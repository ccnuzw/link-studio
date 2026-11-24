import type { CanvasViewPreferences, SettingsValues } from "@link-studio/core";
import { ArrowLeft, Moon, Sparkles, Sun } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CardJump } from "../assistant/info-card";
import { ChoiceButton } from "../choice-button";
import { SkillsPage } from "../skills/skills-page";
import { AdapterManager } from "./adapter-manager";
import { ChannelWorkspace } from "./channel-workspace";
import type { RenderFilingPicker } from "./filing-library";
import { reportPluginAction } from "./plugin-notice";
import { SettingsAssistant } from "./settings-assistant";
import { SettingsDrawer } from "./settings-drawer";
import { settingsRequests } from "./settings-request-log";

const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)");
function subscribeScheme(change: () => void) {
  const query = darkScheme();
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

const errors: Record<string, string> = {
  DRAMA_EPISODE_LOCKED: "本集已拆解，剧本和梗概已锁定。",
  FILING_STORAGE_REQUIRED: "请先在虚拟人像库配置图片对象存储，方舟无法读取本机文件地址。",
  FILING_STORAGE_INVALID: "请检查公网 HTTPS 存储端点、区域、桶名称和公开地址。",
  FILING_STORAGE_KEYS_REQUIRED: "请填写对象存储的 Access Key 和 Secret Key。",
  FILING_STORAGE_UPLOAD_FAILED: "图片上传到对象存储失败，请检查桶和写入权限。",
  DRAMA_APPROVAL_INTERRUPTED: "写入中断，未找到这次审批的写入记录。请重新读取短剧后再申请修改。",
  CHANNEL_HEADERS_INVALID: "请求头名称或值无效，或与系统请求头冲突。",
  CHANNEL_REFERENCED: "请先删除渠道中的模型。",
  CHANNEL_FILING_INVALID: "请填写素材组 ID，并使用方舟或 BytePlus 官方渠道地址。",
  CHANNEL_FILING_IN_USE: "其他渠道已启用虚拟人像库，同一时间只能启用一个。",
  CHANNEL_FILING_KEYS_INVALID: "备案用 Access Key 和 Secret Key 必须一起填写。",
  CHANNEL_FILING_INVALID_MEDIA: "请填写素材名称和可公开访问的图片地址。",
  CHANNEL_FILING_FAILED: "方舟备案请求失败，请检查备案凭证、项目及素材组。",
  CHANNEL_FILING_DUPLICATE: "这张图片已在真人库中。",
  CHANNEL_FILING_RETRY_INVALID: "只有备案失败且保留原图地址的图片可以重新提交。",
  CHANNEL_FILING_HUMAN_MISSING: "这个真人已删除，请重新选择。",
  CHANNEL_FILING_LAST_IMAGE: "这是该真人唯一的图片，请改用「移除真人」。",
  CHANNEL_FILING_IMAGE_IN_USE: "图片正在被角色卡使用，先在角色卡里换掉或删掉。",
  CHANNEL_FILING_HUMAN_FULL: "每个真人最多可添加 5 张图片。",
  CHANNEL_FILING_HUMAN_LIMIT: "真人名称限 1 至 30 个字，最多可保存 200 个真人。",
  CHANNEL_NOT_FOUND: "渠道已删除或不存在，请重新打开模型设置。",
  CHANNEL_TARGET_UNAVAILABLE: "渠道已停用，请启用后再拉取模型。",
  MODEL_CAPABILITIES_INVALID: "能力或参数超出当前协议与模型支持范围。",
  MODEL_PRICING_INVALID: "计价方式或规格条件与模型能力不符，请调整定价。",
  MODEL_PRICING_PENDING: "售价待确认的草稿不能启用，请先完成定价",
  MODEL_ENDPOINT_APPROVAL_REQUIRED: "Vertex AI 凭证地址发生变更，确认地址后才能保存。",
  MODEL_AUTH_APPROVAL_REQUIRED: "凭证授权已变化，请打开模型编辑器核对目标协议并重新授权。",
  MODEL_PENDING: "请先设置模型能力和调用协议。",
  MODEL_DOCUMENT_INVALID: "配置正文有问题，请先修复并保存。",
  MODEL_DOCUMENT_REQUIRED: "模型含有已保存的草稿，请打开编辑器修改，以免覆盖原文。",
  MODEL_DRAFT_UNAVAILABLE: "未能读取模型配置原文。",
  MODEL_TRIAL_INPUT_INVALID: "请检查提示词、生成方式、参考素材或参数是否符合模型能力。",
  MODEL_TRIAL_BUSY: "当前渠道已达到生成并发上限。",
  MODEL_TRIAL_TIMEOUT: "模型试跑等待超时。",
  MODEL_TRIAL_DOWNLOAD_FAILED: "上游已完成生成，下载试跑产物失败。",
  JOB_OUTPUT_INVALID: "试跑产物为空、格式无效或当前预览不支持。",
  PROVIDER_TEST_FAILED: "模型试跑未成功。",
  PROVIDER_SECRET_STORE_UNAVAILABLE: "系统安全存储不可用，凭证未保存。",
  PROVIDER_SECRET_MISSING: "请先填写此服务的凭证。",
  PROVIDER_CHECK_UNSUPPORTED: "此协议未提供可用的只读连接检查。",
  PROVIDER_CHECK_FAILED: "连接检查失败，请检查渠道地址、凭证和服务权限。",
  PROVIDER_CATALOG_AUTH_FAILED: "服务拒绝读取模型列表，请检查凭证与目录读取权限。",
  PROVIDER_CATALOG_UNSUPPORTED: "此端点没有提供兼容的模型目录，可以手动添加。",
  PROVIDER_CATALOG_INVALID: "服务返回的目录格式不受支持，可以手动添加。",
  PROVIDER_CATALOG_TOO_LARGE: "上游模型清单超过大小或数量上限（4 MiB、2000 个模型）。",
  PROVIDER_CATALOG_HTTP_FAILED: "获取模型列表失败，请稍后重试或手动添加。",
  PROVIDER_CATALOG_NETWORK_FAILED: "连接模型目录超时或失败，请检查网络与服务端点。",
  PROVIDER_RESPONSE_LIMIT: "服务响应过大，请手动添加需要的模型。",
  PROVIDER_SHARED_CONNECTION: "请在该 Provider 的主配置中修改连接和凭证。",
  PROVIDER_SHARED_ADAPTER: "含多个模型的 Provider 只能切换到同类型的适配器。",
  PROVIDER_DUPLICATE_MODEL: "此模型已添加到当前 Provider。",
  PROVIDER_DISABLED: "目标渠道已停用，请先启用渠道。",
  CHANNEL_ACTIVE_JOBS: "进行中的任务在用这个渠道，任务结束后可删除。",
  PLUGIN_DISABLED: "此适配器已停用，请在适配器管理中启用。",
  PLUGIN_ACTIVE_REFERENCES: "请先停用引用此适配器的模型。",
  PLUGIN_REFERENCED: "仍有模型引用此版本，无法移除。",
  PLUGIN_JOB_REFERENCED: "仍有生成任务使用此版本。任务结束后可以移除。",
  PLUGIN_BUILTIN_LOCKED: "内置适配器不可移除。",
  PLUGIN_BUILTIN_KEY_RESERVED: "插件标识已被内置插件使用，请修改 meta.key 后再上传。",
  PLUGIN_HOOKS_INVALID: "插件缺少必要钩子或成对钩子不完整。",
  PLUGIN_MANIFEST_INVALID: "适配器声明不符合接口规范，请检查能力、鉴权和必要钩子。",
  PLUGIN_SOURCE_LIMIT: "适配器源码超过 512 KiB。",
  PLUGIN_VERSION_DUPLICATE: "已有相同源码的版本。",
  PLUGIN_VERSION_LIMIT: "补丁版本号已到上限，请提高主版本号或次版本号。",
  PLUGIN_UPGRADE_INCOMPATIBLE: "目标版本的能力、鉴权或服务地址不兼容。",
  PROVIDER_ENDPOINT_BLOCKED: "目标地址不符合网络授权。请检查协议、地址和本地网络许可。",
  SETTINGS_REVISION_CONFLICT: "配置已更新，请重新载入后再保存。",
  PLUGIN_APPROVAL_REQUIRED: "请核对目标地址和插件版本，确认启用。",
  AGENT_MODEL_INCOMPATIBLE:
    "此模型或响应格式不适用于当前操作。请检查 Agent 的网关设置；旧式本地连接仅支持内置 OpenAI 插件。",
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
  AGENT_OVER_BUDGET: "超出本轮积分预算，请减少勾选项或拒绝本次生成。",
  AGENT_GENERATION_PRICE_UNKNOWN: "选中的模型尚未定价，不能在有限预算内批准。",
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

export function SettingsPage({
  close,
  returnLabel,
  preferences,
  changePreferences,
  preferenceError,
  diagnostic,
  renderFilingPicker,
}: {
  close: () => void;
  returnLabel: string;
  preferences: CanvasViewPreferences;
  changePreferences: (patch: Partial<CanvasViewPreferences>) => void;
  preferenceError: boolean;
  diagnostic: ReactNode;
  renderFilingPicker?: RenderFilingPicker;
}) {
  const [data, setData] = useState<SettingsValues["list"]>({ providers: [], plugins: [] });
  const [error, setError] = useState("");
  const [catalogState, setCatalogState] = useState<"loading" | "error" | "ready">("loading");
  const [hasCatalog, setHasCatalog] = useState(false);
  const revision = useRef(0);
  const modelNavigation = useRef(0);
  const [section, setSection] = useState<
    "channels" | "appearance" | "adapters" | "skills" | "diagnostic"
  >("channels");
  const managing = section === "adapters";
  const systemDark = useSyncExternalStore(subscribeScheme, () => darkScheme().matches);
  const dark = preferences.theme === "dark" || (preferences.theme === "system" && systemDark);
  const [skillsVisit, setSkillsVisit] = useState(0);
  const setManaging = (value: boolean) => setSection(value ? "adapters" : "channels");
  const trigger = useRef<HTMLButtonElement>(null);
  const [targetModel, setTargetModel] = useState("");
  const [targetChannel, setTargetChannel] = useState("");
  const [navigation, setNavigation] = useState(0);
  const [selection, setSelection] = useState<{
    channel?: { id: string; label: string };
    modelId?: string;
  }>({});
  const [pluginHash, setPluginHash] = useState<string>();
  const plugin = managing ? data.plugins.find((item) => item.hash === pluginHash) : undefined;
  const [assistant, setAssistant] = useState(false);
  const resolveJump: CardJump = ({ type, key }) => {
    if (type === "plugin") return () => setManaging(true);
    if (!key || (type !== "channel" && type !== "model")) return;
    return async () => {
      const channels = await settingsRequests.channelList({});
      if (!channels.ok) {
        setError(settingsError(channels.code));
        return;
      }
      const model =
        type === "model"
          ? data.providers.find((entry) => entry.id === key || entry.modelKey === key)
          : undefined;
      const channel = channels.value.find(
        (entry) => entry.id === (type === "model" ? model?.channelId : key),
      );
      setManaging(false);
      if (!channel) {
        setError(`${type === "model" ? "模型" : "渠道"} ${key} 不存在`);
        return;
      }
      setError("");
      setTargetChannel(channel.id);
      setTargetModel(model?.id ?? "");
      setNavigation((previous) => previous + 1);
    };
  };
  const toggle = useCallback(() => {
    setAssistant((value) => !value);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        trigger.current?.closest("[hidden]") ||
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector("dialog[open]")
      )
        return;
      if (event.key === "Escape" && assistant) {
        if (document.querySelector(".settings-drawer :popover-open,select:open")) return;
        setAssistant(false);
        trigger.current?.focus();
        return;
      }
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.repeat ||
        event.key.toLowerCase() !== "j" ||
        document.querySelector("dialog[open]")
      )
        return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [toggle, assistant]);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    setCatalogState("loading");
    const result = await settingsRequests
      .list({})
      .catch(() => ({ ok: false as const, code: "SETTINGS_ACTION_FAILED" }));
    if (current !== revision.current) return undefined;
    if (!result.ok) {
      setCatalogState("error");
      setError(settingsError(result.code));
      return undefined;
    }
    setError("");
    setCatalogState("ready");
    setHasCatalog(true);
    setData(result.value);
    return result.value;
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const assistantButton = (
    <button
      ref={trigger}
      type="button"
      className="desk-assistant-trigger"
      aria-label="设置助手"
      aria-keyshortcuts="Control+J Meta+J"
      aria-expanded={assistant}
      onClick={toggle}
    >
      <Sparkles size={16} /> 设置助手{" "}
      <kbd>{navigator.platform.includes("Mac") ? "⌘J" : "Ctrl J"}</kbd>
    </button>
  );

  return (
    <main
      className="model-settings desk-settings"
      aria-label="应用设置"
      data-assistant-open={assistant}
    >
      <div className="settings-page-content">
        <nav className="desk-settings-nav" aria-label="设置分类">
          <button
            type="button"
            className="desk-return"
            onClick={close}
            title={returnLabel}
            aria-label={returnLabel}
          >
            <ArrowLeft size={17} /> <span>{returnLabel}</span>
          </button>
          {(
            [
              ["channels", "模型与渠道"],
              ["appearance", "通用与外观"],
              ["adapters", "适配器管理"],
              ["skills", "技能管理"],
              ["diagnostic", "诊断"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-current={section === id ? "page" : undefined}
              aria-label={label}
              title={label}
              onClick={() => {
                if (id === "skills" && section === "skills") setSkillsVisit((visit) => visit + 1);
                setSection(id);
              }}
            >
              {label}
            </button>
          ))}
          {assistantButton}
          <button
            type="button"
            title={dark ? "切换到浅色" : "切换到深色"}
            aria-label={dark ? "切换到浅色" : "切换到深色"}
            onClick={() => changePreferences({ theme: dark ? "light" : "dark" })}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </nav>
        {error && !managing && (
          <p className="model-notice" role="alert">
            {error}
          </p>
        )}
        <div className="channel-settings-body" data-assistant-open={assistant}>
          {section === "appearance" ? (
            <section className="desk-settings-pane">
              <h2>通用与外观</h2>
              <div className="home-heading">
                <span>应用主题</span>
                <div className="desk-segments" role="radiogroup" aria-label="应用主题">
                  {(
                    [
                      ["system", "跟随系统"],
                      ["light", "浅色"],
                      ["dark", "深色"],
                    ] as const
                  ).map(([value, label]) => (
                    <ChoiceButton
                      key={value}
                      aria-checked={preferences.theme === value}
                      tabIndex={preferences.theme === value ? 0 : -1}
                      onClick={() => changePreferences({ theme: value })}
                    >
                      {label}
                    </ChoiceButton>
                  ))}
                </div>
              </div>
              {preferenceError && <p role="alert">主题偏好保存失败，请重试。</p>}
            </section>
          ) : section === "skills" ? (
            <SkillsPage visit={skillsVisit} />
          ) : section === "diagnostic" ? (
            <div className="desk-settings-pane">{diagnostic}</div>
          ) : managing ? (
            <AdapterManager
              catalogState={catalogState}
              data={data}
              initialHash=""
              onSelection={setPluginHash}
              refresh={refresh}
              openModel={async (id, link) => {
                const request = ++modelNavigation.current;
                if (id) {
                  const result = await settingsRequests
                    .list({})
                    .catch(() => ({ ok: false as const, code: "SETTINGS_ACTION_FAILED" }));
                  if (
                    request !== modelNavigation.current ||
                    (link && (!link.isConnected || !link.closest("dialog[open]")))
                  )
                    return;
                  if (!result.ok) {
                    reportPluginAction(settingsError(result.code), "error");
                    return;
                  }
                  const model = result.value.providers.find((entry) => entry.id === id);
                  if (!model?.channelId) {
                    reportPluginAction("未找到可打开的渠道模型，模型可能已被移除。", "error");
                    return;
                  }
                  setData(result.value);
                  setTargetChannel(model.channelId);
                }
                setTargetModel(id);
                setManaging(false);
              }}
            />
          ) : (
            <ChannelWorkspace
              key={navigation}
              data={data}
              listState={hasCatalog ? "ready" : catalogState}
              refresh={refresh}
              initialChannel={targetChannel}
              initialModel={targetModel}
              onSelection={setSelection}
              renderFilingPicker={renderFilingPicker}
            />
          )}
        </div>
      </div>
      <SettingsDrawer open={assistant}>
        <button
          className="drawer-return"
          type="button"
          onClick={() => {
            setAssistant(false);
            trigger.current?.focus();
          }}
        >
          <ArrowLeft size={16} />
          收起设置助手
        </button>
        <SettingsAssistant
          loadingModels={!hasCatalog && catalogState === "loading"}
          close={toggle}
          resolveJump={resolveJump}
          route={
            section === "channels"
              ? "providers"
              : managing
                ? "adapters"
                : section === "skills"
                  ? "skills"
                  : undefined
          }
          context={
            section === "channels"
              ? data.providers.find((item) => item.id === selection.modelId)
              : undefined
          }
          resource={
            managing
              ? plugin
                ? { id: plugin.hash, key: plugin.key }
                : undefined
              : section === "channels"
                ? selection.channel
                : undefined
          }
          providers={data.providers}
          plugins={data.plugins}
          refresh={refresh}
        />
      </SettingsDrawer>
    </main>
  );
}
