/**
 * 静流主题（Claude 现代风）
 *
 * 米白底 + 白卡片 + 细边框 + 陶土橙点缀；全局唯一色值来源，样式一律引用此处。
 */

export const colors = {
  bg: "#FAF9F5", // 页面底色（Claude 米白）
  surface: "#FFFFFF", // 卡片
  border: "#E8E6E1", // 常规边框
  borderStrong: "#D8D5CE", // 输入框边框
  text: "#1F1E1D", // 主文字
  secondary: "#6B6960", // 次要文字
  faint: "#9B9993", // 弱化文字

  accent: "#D97757", // 陶土橙（主操作）
  accentDark: "#BC5B3E", // 按压态
  accentSoft: "#F7EAE3", // 点缀浅底

  success: "#52702B", // 成功
  successSoft: "#EDF1E4",
  warn: "#9A6A1B", // 中置信
  warnSoft: "#F9EFDB",
  danger: "#B33B2E", // 错误/低置信
  dangerSoft: "#F7E7E3",
} as const;

/** 置信度 → 颜色/文案（推送流徽章用） */
export const confidenceStyles: Record<
  "high" | "medium" | "low",
  { bg: string; text: string; label: string }
> = {
  high: { bg: colors.successSoft, text: colors.success, label: "高置信" },
  medium: { bg: colors.warnSoft, text: colors.warn, label: "中置信" },
  low: { bg: colors.dangerSoft, text: colors.danger, label: "低置信" },
};
