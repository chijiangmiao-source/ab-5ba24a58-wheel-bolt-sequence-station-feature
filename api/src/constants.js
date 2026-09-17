// 复核顺序固定：每个新会话都按此顺序复核六颗螺栓
export const POSITIONS = Object.freeze(['A1', 'B2', 'A3', 'B1', 'A2', 'B3']);
export const TOTAL_STEPS = POSITIONS.length;

// 合格扭矩范围（含边界），单位 cN·m
export const TORQUE_MIN = 4200;
export const TORQUE_MAX = 4800;

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

// 工单码：去除首尾空白后须为 1–64 个字符（字母、数字及 - _ .），不含空白
export const WORK_ORDER_CODE_MAX_LENGTH = 64;
export const WORK_ORDER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
