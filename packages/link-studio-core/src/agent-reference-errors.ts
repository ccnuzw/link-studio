export const agentReferenceErrors = {
  AGENT_REFERENCE_LIMIT: "必要参考素材超过模型或当前方式的上限，请减少连线或手动参考后再申请。",
  AGENT_REFERENCE_UNAVAILABLE: "参考素材不可用，请恢复项目素材或移除引用后再申请。",
  AGENT_ROLE_AVATAR_NOT_READY: "角色主图未就绪或当前方式不支持参考图片，请先确认角色主图。",
  AGENT_ROLE_VOICE_NOT_INCLUDED: "角色声音未带入，请选择支持参考音频的生成方式。",
  AGENT_ROLE_AUDIO_DISABLED: "使用角色音色时请开启声音生成。",
  AGENT_ROLE_VOICE_PENDING: "角色声音尚未就绪，请等待声音生成完成后再申请。",
  AGENT_ROLE_AVATAR_PENDING: "角色主图正在生成，请等主图就绪后重新申请。",
} as const;

export function agentReferenceErrorText(code: string) {
  return Object.hasOwn(agentReferenceErrors, code)
    ? agentReferenceErrors[code as keyof typeof agentReferenceErrors]
    : undefined;
}
