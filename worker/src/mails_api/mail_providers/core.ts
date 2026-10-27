// 多发信服务商：配置解析、按优先级排序、失败分类、换下一家的调度逻辑。
// 这里只放纯逻辑（不依赖 Workers 运行时），便于 node:test 直接测试；
// 具体发信实现与 D1 计数在 index.ts。

export type ProviderType = "resend" | "brevo" | "smtp" | "binding";

export type ProviderSmtpOptions = {
    host: string,
    port: number,
    secure?: boolean,
    startTls?: boolean,
    authType?: string[],
    credentials?: { username: string, password: string },
};

export type ProviderConfig = {
    // 唯一名称，用于日志与用量统计
    name: string,
    type: ProviderType,
    // 数字越小越优先；相同时按配置顺序
    priority: number,
    enabled: boolean,
    // 仅对这些发件域名生效；为空表示所有域名
    domains: string[],
    // 本地额度：达到后跳过该服务商，0 或不填表示不限
    dailyLimit: number,
    monthlyLimit: number,
    // 类型相关
    apiKey?: string,
    // 可选：覆盖 API 地址（自建代理或本地测试）；不填用官方地址
    baseUrl?: string,
    smtp?: ProviderSmtpOptions,
};

export type SendRequest = {
    fromAddress: string,
    fromName: string,
    toMail: string,
    toName: string,
    subject: string,
    content: string,
    isHtml: boolean,
};

// 发信结果分类：
// - quota：服务商额度用尽，换下一家
// - transient：网络、超时、5xx、限流，换下一家
// - auth：密钥失效或域名未验证，换下一家
// - permanent：收件人或内容本身的问题，换哪家都一样，直接报错避免重复发送
export type FailureKind = "quota" | "transient" | "auth" | "permanent";

export class ProviderSendError extends Error {
    kind: FailureKind;
    status?: number;
    constructor(kind: FailureKind, message: string, status?: number) {
        super(message);
        this.name = "ProviderSendError";
        this.kind = kind;
        this.status = status;
    }
}

export type ProviderSendResult = {
    messageId?: string,
    // 服务商返回的真实已用量（如 Resend 响应头），用于展示
    remoteUsage?: { daily?: number, monthly?: number },
};

export type ProviderUsage = { daily: number, monthly: number };

export type AttemptRecord = {
    provider: string,
    type: ProviderType,
    ok: boolean,
    skipped?: "disabled" | "domain" | "daily_limit" | "monthly_limit",
    kind?: FailureKind,
    error?: string,
    durationMs?: number,
};

const VALID_TYPES: ReadonlySet<string> = new Set(["resend", "brevo", "smtp", "binding"]);

const toInt = (value: unknown, fallback = 0): number => {
    const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const normalize = (domain: string): string => domain.trim().toLowerCase().replace(/^@/, "");

/**
 * 解析 MAIL_PROVIDERS（JSON 字符串或数组），丢弃不完整的条目并返回错误说明。
 * 不抛异常：配置写错时只跳过对应条目，避免整个发信功能不可用。
 */
export const parseProviders = (raw: unknown): { providers: ProviderConfig[], errors: string[] } => {
    const errors: string[] = [];
    let list: unknown = raw;
    if (typeof raw === "string") {
        if (!raw.trim()) return { providers: [], errors };
        try {
            list = JSON.parse(raw);
        } catch (e) {
            return { providers: [], errors: [`MAIL_PROVIDERS is not valid JSON: ${(e as Error).message}`] };
        }
    }
    if (list == null) return { providers: [], errors };
    if (!Array.isArray(list)) {
        return { providers: [], errors: ["MAIL_PROVIDERS must be a JSON array"] };
    }

    const providers: ProviderConfig[] = [];
    const seen = new Set<string>();
    list.forEach((item: any, index: number) => {
        const label = `MAIL_PROVIDERS[${index}]`;
        if (!item || typeof item !== "object") {
            errors.push(`${label} must be an object`);
            return;
        }
        const type = String(item.type || "").toLowerCase();
        if (!VALID_TYPES.has(type)) {
            errors.push(`${label} has unsupported type "${item.type}"`);
            return;
        }
        const name = String(item.name || `${type}-${index}`).trim();
        if (seen.has(name)) {
            errors.push(`${label} duplicate name "${name}"`);
            return;
        }
        if ((type === "resend" || type === "brevo") && !item.apiKey) {
            errors.push(`${label} (${name}) requires apiKey`);
            return;
        }
        if (type === "smtp" && !(item.smtp && item.smtp.host && item.smtp.port)) {
            errors.push(`${label} (${name}) requires smtp.host and smtp.port`);
            return;
        }
        seen.add(name);
        providers.push({
            name,
            type: type as ProviderType,
            priority: toInt(item.priority, index + 1),
            enabled: item.enabled !== false,
            domains: Array.isArray(item.domains) ? item.domains.map((d: unknown) => normalize(String(d))).filter(Boolean) : [],
            dailyLimit: toInt(item.dailyLimit),
            monthlyLimit: toInt(item.monthlyLimit),
            apiKey: item.apiKey ? String(item.apiKey) : undefined,
            baseUrl: item.baseUrl ? String(item.baseUrl).replace(/\/+$/, "") : undefined,
            smtp: type === "smtp" ? { ...item.smtp, port: toInt(item.smtp.port) } : undefined,
        });
    });
    return { providers, errors };
};

/** 稳定排序：priority 升序，相同 priority 保持配置顺序 */
export const sortProviders = (providers: ProviderConfig[]): ProviderConfig[] =>
    providers
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.priority - b.p.priority || a.i - b.i)
        .map(({ p }) => p);

export const providerMatchesDomain = (provider: ProviderConfig, domain: string): boolean =>
    provider.domains.length === 0 || provider.domains.includes(normalize(domain));

/** 本地额度判断，返回跳过原因；未超限返回 null */
export const limitSkipReason = (
    provider: ProviderConfig, usage: ProviderUsage
): "daily_limit" | "monthly_limit" | null => {
    if (provider.dailyLimit > 0 && usage.daily >= provider.dailyLimit) return "daily_limit";
    if (provider.monthlyLimit > 0 && usage.monthly >= provider.monthlyLimit) return "monthly_limit";
    return null;
};

/** 依据 HTTP 状态码与服务商错误码给失败分类 */
export const classifyHttpFailure = (status: number, code?: string, message?: string): FailureKind => {
    const text = `${code || ""} ${message || ""}`.toLowerCase();
    // 短时限流（如 Resend rate_limit_exceeded）：稍后会恢复，不算额度用尽
    if (/rate.?limit|too many requests/.test(text)) return "transient";
    if (/quota|credit|daily_limit|monthly_limit|not enough|insufficient/.test(text)) return "quota";
    if (status === 429) return "transient";
    if (status >= 500) return "transient";
    if (status === 401 || status === 403) return "auth";
    // 发件域名未验证、发件人不允许：换一家可能可以发
    if (/domain|sender|from.*(not|un)verified|not.*verified|not allowed to send/.test(text)) return "auth";
    return "permanent";
};

/** 依据 SMTP 异常信息分类（worker-mailer 抛出的是普通 Error） */
export const classifySmtpFailure = (message: string): FailureKind => {
    const text = message.toLowerCase();
    const code = parseInt((text.match(/\b([45]\d\d)\b/) || [])[1] || "0", 10);
    if (/quota|credit|sending limit|daily limit|monthly limit/.test(text)) return "quota";
    if (code === 535 || code === 534 || code === 530 || /auth/.test(text)) return "auth";
    // 550/553 多为收件人不存在或被拒，换服务商也一样
    if (code === 550 || code === 551 || code === 553 || code === 554) return "permanent";
    // 4xx、连接失败、超时
    return "transient";
};

export type Attempt = (provider: ProviderConfig) => Promise<ProviderSendResult>;

/**
 * 按优先级依次尝试：命中额度/域名/禁用则跳过；失败且可重试则换下一家；
 * permanent 失败立即停止并抛出，避免同一封信被多家重复发送。
 */
export const sendWithFailover = async (
    providers: ProviderConfig[],
    domain: string,
    getUsage: (provider: ProviderConfig) => Promise<ProviderUsage>,
    attempt: Attempt,
    now: () => number = () => Date.now(),
): Promise<{ provider: ProviderConfig, result: ProviderSendResult, attempts: AttemptRecord[] }> => {
    const attempts: AttemptRecord[] = [];
    for (const provider of sortProviders(providers)) {
        const base = { provider: provider.name, type: provider.type };
        if (!provider.enabled) {
            attempts.push({ ...base, ok: false, skipped: "disabled" });
            continue;
        }
        if (!providerMatchesDomain(provider, domain)) {
            attempts.push({ ...base, ok: false, skipped: "domain" });
            continue;
        }
        const skip = limitSkipReason(provider, await getUsage(provider));
        if (skip) {
            attempts.push({ ...base, ok: false, skipped: skip });
            continue;
        }
        const started = now();
        try {
            const result = await attempt(provider);
            attempts.push({ ...base, ok: true, durationMs: now() - started });
            return { provider, result, attempts };
        } catch (e) {
            const err = e instanceof ProviderSendError
                ? e
                : new ProviderSendError("transient", (e as Error)?.message || String(e));
            attempts.push({ ...base, ok: false, kind: err.kind, error: err.message.slice(0, 500), durationMs: now() - started });
            if (err.kind === "permanent") {
                throw new FailoverError(`${provider.name}: ${err.message}`, attempts);
            }
        }
    }
    const tried = attempts.filter((a) => !a.skipped);
    const summary = attempts
        .map((a) => a.skipped ? `${a.provider}(skip:${a.skipped})` : `${a.provider}(${a.kind}: ${a.error})`)
        .join("; ");
    throw new FailoverError(
        tried.length ? `All mail providers failed: ${summary}` : `No mail provider available for ${domain}: ${summary || "none configured"}`,
        attempts,
    );
};

export class FailoverError extends Error {
    attempts: AttemptRecord[];
    constructor(message: string, attempts: AttemptRecord[]) {
        super(message);
        this.name = "FailoverError";
        this.attempts = attempts;
    }
}

/** 管理接口展示用：去掉密钥，只保留后 4 位 */
export const redactProvider = (provider: ProviderConfig) => ({
    name: provider.name,
    type: provider.type,
    priority: provider.priority,
    enabled: provider.enabled,
    domains: provider.domains,
    dailyLimit: provider.dailyLimit,
    monthlyLimit: provider.monthlyLimit,
    apiKey: provider.apiKey ? `***${provider.apiKey.slice(-4)}` : undefined,
    smtp: provider.smtp ? {
        host: provider.smtp.host,
        port: provider.smtp.port,
        secure: provider.smtp.secure,
        username: provider.smtp.credentials?.username,
    } : undefined,
});
