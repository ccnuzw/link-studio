import type { MethodCandidate, MethodStep, SkillItem, SkillsValues } from "@link-studio/core";
import { requirePresent } from "@link-studio/core";
import { useCallback, useEffect, useState } from "react";
import { SkillDialog } from "./skill-dialog";

function label(candidate: MethodCandidate) {
  return candidate.source === "builtin" ? "内置方法" : `${candidate.name}@${candidate.version}`;
}

export function MethodWorkbench({ items, close }: { items: SkillItem[]; close: () => void }) {
  const [data, setData] = useState<SkillsValues["steps"]>(),
    [step, setStep] = useState<MethodStep>("marketing.facts"),
    [choice, setChoice] = useState("内置方法"),
    [sample, setSample] = useState(""),
    [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    const reply = await window.desktop.skills.steps({});
    if (reply.ok) setData(reply.value);
    else setError(reply.message);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const protocol = data?.protocols.find((entry) => entry.key === step),
    binding = data?.bindings[step];
  const candidates: MethodCandidate[] = [
    { source: "builtin" },
    ...items
      .filter((item) => item.scopes.includes("agent"))
      .flatMap((item) =>
        item.versions.map((version) => ({
          source: "skill" as const,
          name: item.name,
          version: version.version,
        })),
      ),
  ];
  const selected =
    candidates.find((entry) => label(entry) === choice) ??
    requirePresent(candidates[0], "candidates[0]");
  const [compare, setCompare] = useState(false);
  const models =
    data?.models.filter(
      (entry) =>
        protocol?.media === "none" || entry.vision || (protocol?.media === "video" && entry.video),
    ) ?? [];
  const selectedModel = models.find((entry) => entry.id === model) ?? models[0],
    sampleKey =
      protocol?.samples.find((entry) => entry.key === sample)?.key ?? protocol?.samples[0]?.key;
  const comparisons = new Set(
    data?.trials
      .filter(
        (entry) => entry.step === step && !entry.baseline && label(entry.candidate) === choice,
      )
      .map((entry) => entry.comparison)
      .filter(Boolean),
  );
  const recent =
    data?.trials.filter(
      (entry) =>
        entry.step === step &&
        (label(entry.candidate) === choice ||
          (entry.comparison && comparisons.has(entry.comparison))),
    ) ?? [];
  async function act(trial?: string) {
    if ((!selectedModel && !trial) || !sampleKey) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = trial
        ? await window.desktop.skills.bind({ step, candidate: selected, trial })
        : await window.desktop.skills.trial({
            step,
            candidate: selected,
            sample: sampleKey,
            model: requirePresent(selectedModel, "selectedModel").id,
            revision: requirePresent(selectedModel, "selectedModel").revision,
            compare,
          });
      if (!reply.ok) setError(reply.message);
      else {
        setNotice(
          trial
            ? "环节方法已设为生效"
            : reply.value?.passed
              ? "试跑通过，可设为生效"
              : "试跑未通过，当前绑定未改变",
        );
        await refresh();
      }
    } catch {
      setError("无法连接本机环节技能库。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SkillDialog
      title="环节技能"
      busy={busy}
      close={close}
      footer={
        <button type="button" disabled={busy} onClick={close}>
          关闭
        </button>
      }
    >
      <section className="skill-review method-workbench" aria-busy={busy}>
        <p className="method-note">在这里配置营销工作室的环节方法。短剧环节请在开拍设置中配置。</p>
        {data && protocol && (
          <>
            <fieldset className="method-section" disabled={busy}>
              <legend>环节配置</legend>
              <label className="skill-label">
                环节
                <select
                  aria-label="环节"
                  value={step}
                  onChange={(event) => {
                    setStep(event.target.value as MethodStep);
                    setSample("");
                    setNotice("");
                    setError("");
                  }}
                >
                  {data.protocols.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              <p>{protocol.duty}</p>
              <p className="method-binding">
                <span>当前生效：</span>
                <strong>
                  {binding?.fallback
                    ? `内置方法（原绑定 ${label(binding.candidate)} 不可用）`
                    : label(binding?.candidate ?? { source: "builtin" })}
                </strong>
              </p>
              <details>
                <summary>查看输入和输出协议</summary>
                <p>{protocol.inputs.map((input) => `${input.name} · ${input.desc}`).join("；")}</p>
                <pre>{JSON.stringify(protocol.schema, null, 2)}</pre>
                <p>必须通过：{protocol.rules.hard.join("；")}</p>
                <p>质量提示：{protocol.rules.soft?.join("；") || "无"}</p>
              </details>
            </fieldset>
            <fieldset className="method-section" disabled={busy}>
              <legend>试跑配置</legend>
              <div className="method-fields">
                <label className="skill-label">
                  候选方法
                  <select
                    value={choice}
                    onChange={(event) => {
                      setChoice(event.target.value);
                      setNotice("");
                    }}
                  >
                    {candidates.map((entry) => (
                      <option key={label(entry)}>{label(entry)}</option>
                    ))}
                  </select>
                </label>
                <label className="skill-label">
                  试跑样例
                  <select
                    value={sampleKey ?? ""}
                    onChange={(event) => setSample(event.target.value)}
                  >
                    {protocol.samples.map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="skill-label">
                  试跑模型
                  <select
                    value={selectedModel?.id ?? ""}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {!models.length && <option value="">没有支持此环节的模型</option>}
                    {models.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="method-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={compare}
                    onChange={(event) => setCompare(event.target.checked)}
                  />
                  使用同一模型和样例，与当前生效方法对比
                </label>
                <button
                  type="button"
                  className="skill-primary"
                  disabled={!selectedModel || !sampleKey}
                  onClick={() => void act()}
                >
                  {busy ? "处理中…" : "试跑候选方法"}
                </button>
              </div>
            </fieldset>
            <details>
              <summary>生产统计与生效历史</summary>
              <p>
                近 7 天生产失败率：
                {binding?.total
                  ? `${((100 * binding.failed) / binding.total).toFixed(1)}%（${binding.failed}/${binding.total}）`
                  : "暂无生产运行"}
                ，不计入试跑。
              </p>
              {binding?.history.map((item) => (
                <p key={item.id}>
                  {new Date(item.at).toLocaleString()} · 生效 {label(item.candidate)} · 试跑{" "}
                  {item.trial}
                </p>
              ))}
            </details>
            <h3>试跑记录</h3>
            {!recent.length && (
              <p className="method-empty">
                还没有试跑记录。完成试跑后，可在这里查看结果并启用通过校验的方法。
              </p>
            )}
            {recent.map((trial) => (
              <div key={trial.id} className="skill-confirm">
                <strong>
                  {trial.baseline ? "对照" : "候选"} · {label(trial.candidate)} ·{" "}
                  {trial.passed ? "校验通过" : "未通过"}
                </strong>
                <p>
                  {trial.sample} ·{" "}
                  {data.models.find((entry) => entry.id === trial.model)?.label ?? trial.model} ·{" "}
                  {new Date(trial.finished).toLocaleString()}
                </p>
                <p>{trial.preview}</p>
                {Array.from(new Set(trial.issues)).map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
                <button
                  type="button"
                  disabled={
                    busy ||
                    !trial.passed ||
                    label(trial.candidate) !== choice ||
                    Date.now() - trial.finished > 86400000
                  }
                  onClick={() => void act(trial.id)}
                >
                  按此次试跑设为生效
                </button>
              </div>
            ))}
          </>
        )}
        {data && (
          <details>
            <summary>视频模型格式化器（只读）</summary>
            <p>同一份脚本的不同输出格式，不读取技能，也不调用模型。</p>
            {data.formatters.map((formatter) => (
              <details key={formatter.key}>
                <summary>{formatter.name}</summary>
                <p>{formatter.description}</p>
                <pre>{formatter.preview}</pre>
              </details>
            ))}
          </details>
        )}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!data && !error && <p role="status">正在读取环节协议…</p>}
      </section>
    </SkillDialog>
  );
}
