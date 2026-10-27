import { Context } from 'hono';

import { getBooleanValue, getIntValue } from '../utils';
import { getMailProviderLogs, getMailProviderStatus } from '../mails_api/mail_providers';

export default {
    // GET /admin/mail_providers?remote=true  各服务商配置（已脱敏）、本地日/月用量、可选的服务商侧余量
    status: async (c: Context<HonoCustomType>) => {
        const { remote } = c.req.query();
        return c.json(await getMailProviderStatus(c, getBooleanValue(remote)));
    },
    // GET /admin/mail_providers/logs?limit=20&offset=0&provider=resend  每次实际发信尝试的记录
    logs: async (c: Context<HonoCustomType>) => {
        const { limit, offset, provider } = c.req.query();
        const safeLimit = Math.min(Math.max(getIntValue(limit, 20), 1), 100);
        const safeOffset = Math.max(getIntValue(offset, 0), 0);
        return c.json(await getMailProviderLogs(c, safeLimit, safeOffset, provider || undefined));
    },
};
