// 多发信服务商运行时：具体发信实现、D1 用量计数与发送日志、服务商余量查询。
import { Context } from 'hono';
import { Resend } from 'resend';
import { WorkerMailer, WorkerMailerOptions } from 'worker-mailer';

import { getSetting, saveSetting } from '../../utils';

import {
    AttemptRecord,
    FailoverError,
    ProviderConfig,
    ProviderSendError,
    ProviderSendResult,
    ProviderUsage,
    SendRequest,
    classifyHttpFailure,
    classifySmtpFailure,
    parseProviders,
    redactProvider,
    sendWithFailover,
    sortProviders,
} from './core';

export { FailoverError } from './core';

const BREVO_API = "https://api.brevo.com/v3";
const brevoApi = (provider: ProviderConfig) => provider.baseUrl || BREVO_API;
const REMOTE_USAGE_KEY_PREFIX = "mail_provider_remote_usage:";

// 每日/每月按 UTC 计算，与 Resend、Brevo 的重置时间一致
const usageWindows = (now = new Date()) => {
    const iso = now.toISOString();
    return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
};

export const getMailProviders = (c: Context<HonoCustomType>): ProviderConfig[] => {
    const { providers, errors } = parseProviders(c.env.MAIL_PROVIDERS);
    if (errors.length) console.warn(`MAIL_PROVIDERS: ${errors.join("; ")}`);
    return providers;
};

export const hasMailProviders = (c: Context<HonoCustomType>): boolean =>
    getMailProviders(c).length > 0;

// ---------------- D1：用量计数 + 发送日志 ----------------

// 与 db/2026-10-27-mail-providers.sql 一致。按需建表，不改 DB_VERSION，避免与上游迁移冲突
const TABLE_DDL = [
    `CREATE TABLE IF NOT EXISTS mail_provider_usage (
        provider TEXT NOT NULL,
        period TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, period)
    )`,
    `CREATE TABLE IF NOT EXISTS mail_provider_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        provider_type TEXT,
        from_address TEXT,
        to_mail TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        error_kind TEXT,
        error TEXT,
        duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mail_provider_log_created_at ON mail_provider_log(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mail_provider_log_provider ON mail_provider_log(provider)`,
];

// 每个 isolate 只建一次表
let tablesReady: Promise<void> | null = null;
const ensureTables = (c: Context<HonoCustomType>): Promise<void> => {
    tablesReady ??= c.env.DB.batch(TABLE_DDL.map((sql) => c.env.DB.prepare(sql)))
        .then(() => undefined)
        .catch((e) => {
            tablesReady = null;
            throw e;
        });
    return tablesReady;
};

// 写用量/日志失败不能影响发信本身
const safeRun = async (fn: () => Promise<unknown>) => {
    try {
        await fn();
    } catch (e) {
        console.warn("mail provider bookkeeping failed", e);
    }
};

const getUsage = async (c: Context<HonoCustomType>, provider: string): Promise<ProviderUsage> => {
    const { day, month } = usageWindows();
    try {
        await ensureTables(c);
        const rows = await c.env.DB.prepare(
            `SELECT period, count FROM mail_provider_usage WHERE provider = ? AND period IN (?, ?)`
        ).bind(provider, `d:${day}`, `m:${month}`).all<{ period: string, count: number }>();
        const map = new Map((rows.results || []).map((r) => [r.period, r.count]));
        return { daily: map.get(`d:${day}`) || 0, monthly: map.get(`m:${month}`) || 0 };
    } catch {
        return { daily: 0, monthly: 0 };
    }
};

const increaseUsage = async (c: Context<HonoCustomType>, provider: string) => {
    const { day, month } = usageWindows();
    const upsert = `INSERT INTO mail_provider_usage (provider, period, count) VALUES (?, ?, 1)
        ON CONFLICT(provider, period) DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP`;
    await safeRun(() => c.env.DB.batch([
        c.env.DB.prepare(upsert).bind(provider, `d:${day}`),
        c.env.DB.prepare(upsert).bind(provider, `m:${month}`),
    ]));
};

const writeLogs = async (
    c: Context<HonoCustomType>, req: SendRequest, attempts: AttemptRecord[]
) => {
    const tried = attempts.filter((a) => !a.skipped);
    if (!tried.length) return;
    const stmt = `INSERT INTO mail_provider_log
        (provider, provider_type, from_address, to_mail, success, error_kind, error, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await safeRun(() => c.env.DB.batch(tried.map((a) => c.env.DB.prepare(stmt).bind(
        a.provider, a.type, req.fromAddress, req.toMail, a.ok ? 1 : 0,
        a.kind || null, a.error || null, a.durationMs ?? null,
    ))));
};

// ---------------- 各服务商发信实现 ----------------

const formatAddress = (name: string, email: string) => (name ? `${name} <${email}>` : email);

const sendByResend = async (provider: ProviderConfig, req: SendRequest): Promise<ProviderSendResult> => {
    const resend = new Resend(provider.apiKey, provider.baseUrl ? { baseUrl: provider.baseUrl } : undefined);
    const { data, error, headers } = await resend.emails.send({
        from: formatAddress(req.fromName, req.fromAddress),
        to: formatAddress(req.toName, req.toMail),
        subject: req.subject,
        ...(req.isHtml ? { html: req.content } : { text: req.content }),
    });
    if (error) {
        // resend SDK 把 HTTP 状态放在 statusCode，错误码放在 name
        const status = error.statusCode || 0;
        throw new ProviderSendError(classifyHttpFailure(status, error.name, error.message), `${error.name}: ${error.message}`, status);
    }
    const daily = Number(headers?.["x-resend-daily-quota"]);
    const monthly = Number(headers?.["x-resend-monthly-quota"]);
    return {
        messageId: data?.id,
        remoteUsage: {
            daily: Number.isFinite(daily) ? daily : undefined,
            monthly: Number.isFinite(monthly) ? monthly : undefined,
        },
    };
};

const sendByBrevo = async (provider: ProviderConfig, req: SendRequest): Promise<ProviderSendResult> => {
    const res = await fetch(`${brevoApi(provider)}/smtp/email`, {
        method: "POST",
        headers: { "api-key": provider.apiKey as string, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
            sender: req.fromName ? { name: req.fromName, email: req.fromAddress } : { email: req.fromAddress },
            to: [req.toName ? { email: req.toMail, name: req.toName } : { email: req.toMail }],
            subject: req.subject,
            ...(req.isHtml ? { htmlContent: req.content } : { textContent: req.content }),
        }),
    });
    const body = await res.json().catch(() => ({})) as { messageId?: string, code?: string, message?: string };
    if (!res.ok) {
        throw new ProviderSendError(classifyHttpFailure(res.status, body.code, body.message), `${res.status} ${body.code || ""}: ${body.message || ""}`.trim(), res.status);
    }
    return { messageId: body.messageId };
};

const sendBySmtp = async (provider: ProviderConfig, req: SendRequest): Promise<ProviderSendResult> => {
    try {
        await WorkerMailer.send(provider.smtp as unknown as WorkerMailerOptions, {
            from: { name: req.fromName, email: req.fromAddress },
            to: { name: req.toName, email: req.toMail },
            subject: req.subject,
            text: req.isHtml ? undefined : req.content,
            html: req.isHtml ? req.content : undefined,
        });
        return {};
    } catch (e) {
        const message = (e as Error)?.message || String(e);
        throw new ProviderSendError(classifySmtpFailure(message), message);
    }
};

const sendByBinding = async (c: Context<HonoCustomType>, req: SendRequest): Promise<ProviderSendResult> => {
    if (!c.env.SEND_MAIL) throw new ProviderSendError("auth", "SEND_MAIL binding is not configured");
    try {
        await c.env.SEND_MAIL.send({
            from: req.fromName ? { email: req.fromAddress, name: req.fromName } : req.fromAddress,
            to: req.toName ? [`${req.toName} <${req.toMail}>`] : [req.toMail],
            subject: req.subject,
            ...(req.isHtml ? { html: req.content } : { text: req.content }),
        } as any);
        return {};
    } catch (e) {
        throw new ProviderSendError("transient", (e as Error)?.message || String(e));
    }
};

// ---------------- 对外入口 ----------------

/**
 * 按优先级发信，失败或额度用尽时自动换下一家。
 * 成功后累加该服务商的日/月用量；每次实际尝试都写入 mail_provider_log。
 */
export const sendMailWithProviders = async (
    c: Context<HonoCustomType>, req: SendRequest, domain: string
): Promise<{ provider: string, messageId?: string }> => {
    const providers = getMailProviders(c);
    try {
        const { provider, result, attempts } = await sendWithFailover(
            providers, domain,
            (p) => getUsage(c, p.name),
            (p) => {
                switch (p.type) {
                    case "resend": return sendByResend(p, req);
                    case "brevo": return sendByBrevo(p, req);
                    case "smtp": return sendBySmtp(p, req);
                    case "binding": return sendByBinding(c, req);
                }
            },
        );
        await increaseUsage(c, provider.name);
        await writeLogs(c, req, attempts);
        if (result.remoteUsage && (result.remoteUsage.daily !== undefined || result.remoteUsage.monthly !== undefined)) {
            await safeRun(() => saveSetting(
                c, `${REMOTE_USAGE_KEY_PREFIX}${provider.name}`,
                JSON.stringify({ ...result.remoteUsage, at: new Date().toISOString() }),
            ));
        }
        console.log(`mail sent via ${provider.name}${attempts.length > 1 ? ` after ${attempts.length - 1} skip/failover` : ""}`);
        return { provider: provider.name, messageId: result.messageId };
    } catch (e) {
        if (e instanceof FailoverError) await writeLogs(c, req, e.attempts);
        throw e;
    }
};

// 查询服务商侧的真实余量（尽力而为：查询失败只返回错误信息，不影响其它服务商）
const fetchRemoteQuota = async (c: Context<HonoCustomType>, provider: ProviderConfig) => {
    try {
        if (provider.type === "brevo") {
            const res = await fetch(`${brevoApi(provider)}/account`, { headers: { "api-key": provider.apiKey as string, accept: "application/json" } });
            const body = await res.json() as any;
            if (!res.ok) return { error: `${res.status} ${body?.message || ""}`.trim() };
            const plans = (body?.plan || []).map((p: any) => ({ type: p.type, creditsType: p.creditsType, credits: p.credits }));
            return { plans };
        }
        if (provider.type === "resend") {
            const row = await getSetting(c, `${REMOTE_USAGE_KEY_PREFIX}${provider.name}`);
            // Resend 没有查询用量的接口，只能读取最近一次发信响应头里的已用量
            return row ? { lastSeenUsage: JSON.parse(row), note: "from x-resend-*-quota headers of the last send" } : { note: "no send yet" };
        }
    } catch (e) {
        return { error: (e as Error).message };
    }
    return null;
};

export const getMailProviderStatus = async (c: Context<HonoCustomType>, withRemote: boolean) => {
    const { providers, errors } = parseProviders(c.env.MAIL_PROVIDERS);
    const sorted = sortProviders(providers);
    const items = await Promise.all(sorted.map(async (p) => ({
        ...redactProvider(p),
        usage: await getUsage(c, p.name),
        remote: withRemote ? await fetchRemoteQuota(c, p) : undefined,
    })));
    return { providers: items, configErrors: errors, window: usageWindows() };
};

export const getMailProviderLogs = async (c: Context<HonoCustomType>, limit: number, offset: number, provider?: string) => {
    await ensureTables(c);
    const where = provider ? `WHERE provider = ?` : ``;
    const binds = provider ? [provider] : [];
    const [rows, total] = await Promise.all([
        c.env.DB.prepare(`SELECT * FROM mail_provider_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all(),
        c.env.DB.prepare(`SELECT count(*) as count FROM mail_provider_log ${where}`).bind(...binds).first<number>("count"),
    ]);
    return { results: rows.results || [], count: total || 0 };
};
