/**
 * 渠道健康状态与冷却。
 *
 * 设计要点：
 * - 冷却时长按失败类型区分：429（限流）退避最久，5xx 短退避，401/403（key 失效）长退避，
 *   这样一把填错的 key 不会在每个请求上白等一轮超时。
 * - 连续失败会指数放大冷却，成功一次立刻清零 —— 免费额度大多是"窗口恢复"型，
 *   到点就该立刻放它回来，所以冷却到期即视为可用。
 * - 429 如果带了 Retry-After，优先采用上游说的时长。
 */

const REASON = {
  rateLimit: 'rateLimit',
  serverError: 'serverError',
  authError: 'authError',
  network: 'network',
  badRequest: 'badRequest',
  empty: 'empty',
};

export const FAIL = REASON;

/** 把上游 HTTP 状态码归类成失败原因。 */
export function classifyStatus(status) {
  if (status === 429) return REASON.rateLimit;
  if (status === 401 || status === 403) return REASON.authError;
  if (status === 402) return REASON.authError; // 余额不足，等同不可用
  if (status === 404) return REASON.badRequest; // 模型名/接入点不对
  if (status >= 500) return REASON.serverError;
  if (status >= 400) return REASON.badRequest;
  return null;
}

export class HealthRegistry {
  constructor(cooldownCfg) {
    this.cfg = cooldownCfg;
    this.state = new Map();
  }

  _get(id) {
    let s = this.state.get(id);
    if (!s) {
      s = {
        id,
        cooldownUntil: 0,
        consecutiveFailures: 0,
        lastError: null,
        lastErrorAt: null,
        lastOkAt: null,
        totalRequests: 0,
        totalFailures: 0,
        totalOk: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
      this.state.set(id, s);
    }
    return s;
  }

  isAvailable(id, now = Date.now()) {
    const s = this._get(id);
    return s.cooldownUntil <= now;
  }

  /** 距离可用还要多久（毫秒），0 表示现在可用。 */
  retryAfterMs(id, now = Date.now()) {
    const s = this._get(id);
    return Math.max(0, s.cooldownUntil - now);
  }

  cooldownRemaining(id) {
    return this.retryAfterMs(id);
  }

  markRequest(id) {
    this._get(id).totalRequests += 1;
  }

  markSuccess(id, usage) {
    const s = this._get(id);
    s.consecutiveFailures = 0;
    s.cooldownUntil = 0;
    s.lastError = null;
    s.lastOkAt = Date.now();
    s.totalOk += 1;
    if (usage) {
      s.usage.promptTokens += Number(usage.prompt_tokens ?? 0);
      s.usage.completionTokens += Number(usage.completion_tokens ?? 0);
      s.usage.totalTokens += Number(usage.total_tokens ?? 0);
    }
  }

  /**
   * 记录失败并设置冷却。
   * @param {string} id
   * @param {string} reason 见 FAIL
   * @param {{message?:string, retryAfterMs?:number}} [detail]
   */
  markFailure(id, reason, detail = {}) {
    const s = this._get(id);
    s.consecutiveFailures += 1;
    s.totalFailures += 1;
    s.lastError = detail.message ?? reason;
    s.lastErrorAt = Date.now();

    // 注意：this.cfg 就是 cooldown 配置对象本身（由 index.mjs 传 config.policy.cooldown），
    // 不要再取 .cooldown —— 那会得到 undefined 并在每次失败时抛异常。
    const { minMs, maxMs } = this.cfg;
    let base;
    switch (reason) {
      case REASON.rateLimit:
        base = this.cfg.rateLimitMs;
        break;
      case REASON.authError:
        base = this.cfg.authErrorMs;
        break;
      case REASON.serverError:
      case REASON.network:
      case REASON.empty:
        base = this.cfg.serverErrorMs;
        break;
      case REASON.badRequest:
      default:
        // 请求本身有问题（比如模型名不对）—— 短冷却，且不要惩罚成倍放大
        base = Math.max(minMs, 5000);
        break;
    }

    // 指数放大：第 1 次 base，第 2 次 2×，第 3 次 4×……
    const growth = reason === REASON.badRequest ? 1 : 2 ** Math.min(s.consecutiveFailures - 1, 4);
    let wait = base * growth;
    if (detail.retryAfterMs && Number.isFinite(detail.retryAfterMs)) {
      wait = Math.max(wait, detail.retryAfterMs);
    }
    wait = Math.min(Math.max(wait, minMs), maxMs);
    s.cooldownUntil = Date.now() + wait;
    s.cooldownReason = reason;
    return wait;
  }

  /** 手动解除冷却（运维用）。 */
  clear(id) {
    const s = this._get(id);
    s.cooldownUntil = 0;
    s.consecutiveFailures = 0;
    s.lastError = null;
  }

  snapshot() {
    const now = Date.now();
    return [...this.state.values()].map((s) => ({
      ...s,
      coolingMs: Math.max(0, s.cooldownUntil - now),
      available: s.cooldownUntil <= now,
    }));
  }
}
