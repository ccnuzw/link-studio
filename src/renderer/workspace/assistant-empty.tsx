import {
  ArrowUpRight,
  BookOpenText,
  Clapperboard,
  FilePen,
  History,
  LayoutGrid,
  ListChecks,
  Settings2,
  Users,
} from "lucide-react";
import { motion } from "motion/react";

const starters = [
  { icon: Clapperboard, text: "把选中的剧本拆成分镜" },
  { icon: Users, text: "整理人物，做一份资产清单" },
  { icon: LayoutGrid, text: "把画布按场景整理整齐" },
];

const settingsStarters = [
  { icon: Settings2, text: "查看当前页面的配置和状态" },
  { icon: History, text: "查询最近失败的任务和运行记录" },
  { icon: ListChecks, text: "查看最近的操作审计" },
];
const dramaStarters = [
  { icon: BookOpenText, text: "读一遍大纲，告诉我哪里可以更紧凑" },
  { icon: FilePen, text: "把第 1 集的结尾改得更有悬念" },
  { icon: Clapperboard, text: "检查各集的分镜片段，看提示词有没有遗漏" },
];

export function CanvasAssistantEmpty({
  hasModel,
  onStarter,
  settings = false,
  drama = false,
}: {
  hasModel: boolean;
  settings?: boolean;
  drama?: boolean;
  onStarter: (text: string) => void;
}) {
  return (
    <div className="canvas-assistant-welcome">
      <span className="assistant-orb" aria-hidden="true" />
      <strong>
        {settings
          ? "让助手帮你调整后台配置"
          : drama
            ? "让助手帮你改剧本、资产和分镜"
            : "让 Agent 帮你把想法搭成分镜"}
      </strong>
      {!settings && (
        <p>
          {drama
            ? "先读后改；改剧本、改片段、提交任务前都会给出审批卡，批准后才写入"
            : hasModel
              ? "读懂画布、搭建节点、整理布局；花积分和删除前都会先问你"
              : "启用一个对话模型，就可以和小灵一起创作。"}
        </p>
      )}
      <div className="assistant-starters">
        {(settings ? settingsStarters : drama ? dramaStarters : starters).map(
          ({ icon: Icon, text }) => (
            <motion.button
              type="button"
              key={text}
              whileTap={{ scale: 0.985 }}
              onClick={() => onStarter(text)}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{text}</span>
              <ArrowUpRight size={14} aria-hidden="true" />
            </motion.button>
          ),
        )}
      </div>
      {!settings && !drama && (
        <small>
          <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} /</kbd>随时唤起 · <kbd>@</kbd>
          引用节点 · <kbd>/</kbd>插入技能
        </small>
      )}
    </div>
  );
}
