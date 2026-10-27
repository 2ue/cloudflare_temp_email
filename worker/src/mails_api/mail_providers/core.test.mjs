import assert from "node:assert/strict";
import test from "node:test";

import {
    FailoverError,
    ProviderSendError,
    classifyHttpFailure,
    classifySmtpFailure,
    limitSkipReason,
    parseProviders,
    redactProvider,
    sendWithFailover,
    sortProviders,
} from "./core.ts";

const resend = { name: "resend", type: "resend", priority: 1, apiKey: "re_secret_abcd" };
const brevo = { name: "brevo", type: "brevo", priority: 2, apiKey: "xkeysib-secret-wxyz" };

const providersOf = (...items) => parseProviders(items).providers;
const noUsage = async () => ({ daily: 0, monthly: 0 });

test("parseProviders keeps valid entries and reports broken ones", () => {
    const { providers, errors } = parseProviders(JSON.stringify([
        resend,
        { name: "bad-type", type: "mailgun", apiKey: "x" },
        { name: "no-key", type: "brevo" },
        { name: "smtp", type: "smtp", smtp: { host: "smtp.example.com", port: "587" } },
        { name: "resend", type: "resend", apiKey: "dup" },
    ]));
    assert.deepEqual(providers.map((p) => p.name), ["resend", "smtp"]);
    assert.equal(providers[1].smtp.port, 587);
    assert.equal(errors.length, 3);
});

test("parseProviders tolerates empty or invalid input without throwing", () => {
    assert.deepEqual(parseProviders(undefined).providers, []);
    assert.deepEqual(parseProviders("").providers, []);
    assert.equal(parseProviders("{not json").errors.length, 1);
    assert.equal(parseProviders({ name: "x" }).errors[0], "MAIL_PROVIDERS must be a JSON array");
});

test("parseProviders normalizes domains and defaults", () => {
    const [p] = providersOf({ ...resend, domains: ["@Mail.OKMCODE.com"], dailyLimit: "100" });
    assert.deepEqual(p.domains, ["mail.okmcode.com"]);
    assert.equal(p.dailyLimit, 100);
    assert.equal(p.monthlyLimit, 0);
    assert.equal(p.enabled, true);
});

test("sortProviders is stable by priority", () => {
    const list = providersOf(
        { ...brevo, priority: 2 },
        { name: "smtp-a", type: "smtp", priority: 1, smtp: { host: "a", port: 25 } },
        { ...resend, priority: 1 },
    );
    assert.deepEqual(sortProviders(list).map((p) => p.name), ["smtp-a", "resend", "brevo"]);
});

test("limitSkipReason honours daily before monthly and treats 0 as unlimited", () => {
    const [p] = providersOf({ ...resend, dailyLimit: 100, monthlyLimit: 3000 });
    assert.equal(limitSkipReason(p, { daily: 99, monthly: 10 }), null);
    assert.equal(limitSkipReason(p, { daily: 100, monthly: 10 }), "daily_limit");
    assert.equal(limitSkipReason(p, { daily: 1, monthly: 3000 }), "monthly_limit");
    const [unlimited] = providersOf(brevo);
    assert.equal(limitSkipReason(unlimited, { daily: 10_000, monthly: 10_000 }), null);
});

test("classifyHttpFailure separates retryable from permanent errors", () => {
    assert.equal(classifyHttpFailure(429, "daily_quota_exceeded"), "quota");
    assert.equal(classifyHttpFailure(429, "rate_limit_exceeded"), "transient");
    assert.equal(classifyHttpFailure(402, "not_enough_credits"), "quota");
    assert.equal(classifyHttpFailure(503), "transient");
    assert.equal(classifyHttpFailure(401, "unauthorized"), "auth");
    assert.equal(classifyHttpFailure(403, "validation_error", "The mail.okmcode.com domain is not verified"), "auth");
    assert.equal(classifyHttpFailure(422, "invalid_parameter", "Invalid `to` field"), "permanent");
});

test("classifySmtpFailure maps SMTP replies", () => {
    assert.equal(classifySmtpFailure("535 5.7.8 Authentication failed"), "auth");
    assert.equal(classifySmtpFailure("550 5.1.1 Recipient address rejected"), "permanent");
    assert.equal(classifySmtpFailure("451 4.3.0 Try again later"), "transient");
    assert.equal(classifySmtpFailure("Connection timed out"), "transient");
    assert.equal(classifySmtpFailure("421 too many messages, daily quota exceeded"), "quota");
});

test("uses the highest priority provider when it succeeds", async () => {
    const calls = [];
    const { provider, attempts } = await sendWithFailover(
        providersOf(brevo, resend), "mail.okmcode.com", noUsage,
        async (p) => { calls.push(p.name); return { messageId: "m1" }; },
    );
    assert.equal(provider.name, "resend");
    assert.deepEqual(calls, ["resend"]);
    assert.deepEqual(attempts.map((a) => [a.provider, a.ok]), [["resend", true]]);
});

test("fails over to the next provider on quota exhaustion", async () => {
    const calls = [];
    const { provider, attempts } = await sendWithFailover(
        providersOf(resend, brevo), "mail.okmcode.com", noUsage,
        async (p) => {
            calls.push(p.name);
            if (p.name === "resend") throw new ProviderSendError("quota", "daily_quota_exceeded", 429);
            return {};
        },
    );
    assert.equal(provider.name, "brevo");
    assert.deepEqual(calls, ["resend", "brevo"]);
    assert.equal(attempts[0].kind, "quota");
});

test("skips providers whose local limit is reached without calling them", async () => {
    const calls = [];
    const usage = async (p) => (p.name === "resend" ? { daily: 100, monthly: 100 } : { daily: 0, monthly: 0 });
    const { provider, attempts } = await sendWithFailover(
        providersOf({ ...resend, dailyLimit: 100 }, brevo), "mail.okmcode.com", usage,
        async (p) => { calls.push(p.name); return {}; },
    );
    assert.equal(provider.name, "brevo");
    assert.deepEqual(calls, ["brevo"]);
    assert.equal(attempts[0].skipped, "daily_limit");
});

test("skips disabled providers and providers bound to other domains", async () => {
    const { provider, attempts } = await sendWithFailover(
        providersOf({ ...resend, enabled: false }, { ...brevo, domains: ["other.com"] }, { name: "smtp", type: "smtp", priority: 3, smtp: { host: "h", port: 587 } }),
        "mail.okmcode.com", noUsage, async () => ({}),
    );
    assert.equal(provider.name, "smtp");
    assert.deepEqual(attempts.slice(0, 2).map((a) => a.skipped), ["disabled", "domain"]);
});

test("stops on permanent failure to avoid duplicate delivery", async () => {
    const calls = [];
    await assert.rejects(
        sendWithFailover(providersOf(resend, brevo), "mail.okmcode.com", noUsage, async (p) => {
            calls.push(p.name);
            throw new ProviderSendError("permanent", "Invalid `to` field", 422);
        }),
        (err) => err instanceof FailoverError && /resend: Invalid/.test(err.message) && err.attempts.length === 1,
    );
    assert.deepEqual(calls, ["resend"]);
});

test("treats unknown thrown errors as transient and keeps going", async () => {
    const { provider } = await sendWithFailover(
        providersOf(resend, brevo), "mail.okmcode.com", noUsage,
        async (p) => { if (p.name === "resend") throw new TypeError("fetch failed"); return {}; },
    );
    assert.equal(provider.name, "brevo");
});

test("reports every attempt when all providers fail", async () => {
    await assert.rejects(
        sendWithFailover(providersOf(resend, brevo), "mail.okmcode.com", noUsage, async (p) => {
            throw new ProviderSendError(p.name === "resend" ? "quota" : "auth", `${p.name} down`);
        }),
        (err) => err instanceof FailoverError
            && /All mail providers failed/.test(err.message)
            && err.attempts.map((a) => a.kind).join() === "quota,auth",
    );
});

test("reports no provider when nothing matches", async () => {
    await assert.rejects(
        sendWithFailover([], "mail.okmcode.com", noUsage, async () => ({})),
        /No mail provider available for mail.okmcode.com/,
    );
});

test("redactProvider never exposes secrets", () => {
    const [r] = providersOf(resend);
    const [s] = providersOf({ name: "smtp", type: "smtp", smtp: { host: "h", port: 587, credentials: { username: "u", password: "p@ss" } } });
    assert.equal(redactProvider(r).apiKey, "***abcd");
    assert.equal(JSON.stringify(redactProvider(s)).includes("p@ss"), false);
});
