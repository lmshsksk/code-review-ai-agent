const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * 本地 webhook 调试脚本
 * 用法:
 * 1) 启动服务: pnpm run webhook
 * 2) 发送 mock: pnpm run demo:webhook
 */
function loadLocalEnv() {
    const envLocalPath = path.join(__dirname, '.env.local');
    const envPath = path.join(__dirname, '.env');

    if (fs.existsSync(envLocalPath)) {
        require('dotenv').config({ path: envLocalPath });
    } else if (fs.existsSync(envPath)) {
        require('dotenv').config({ path: envPath });
    }
}

async function main() {
    loadLocalEnv();

    const payloadPath = process.argv[2]
        ? path.resolve(process.cwd(), process.argv[2])
        : path.resolve(__dirname, 'mock/gitlab_webhook_merge_request.json');

    if (!fs.existsSync(payloadPath)) {
        throw new Error(`mock 文件不存在: ${payloadPath}`);
    }

    const raw = fs.readFileSync(payloadPath, 'utf-8');
    // 兼容 UTF-8 BOM 文件，避免 JSON.parse 失败
    const payload = JSON.parse(raw.replace(/^\uFEFF/, ''));

    const webhookPort = process.env.WEBHOOK_PORT || '8080';
    const webhookUrl = process.env.WEBHOOK_DEMO_URL || `http://127.0.0.1:${webhookPort}/webhook/gitlab`;

    const headers = {
        'Content-Type': 'application/json',
    };

    // 如果配置了 webhook 密钥，这里自动带上请求头
    if (process.env.GITLAB_WEBHOOK_SECRET) {
        headers['X-Gitlab-Token'] = process.env.GITLAB_WEBHOOK_SECRET;
    }

    const response = await axios.post(webhookUrl, payload, { headers, timeout: 10000 });

    console.log(`status: ${response.status}`);
    console.log('response:');
    console.log(JSON.stringify(response.data, null, 2));
}

main().catch(error => {
    if (error.response) {
        console.error(`status: ${error.response.status}`);
        console.error(JSON.stringify(error.response.data, null, 2));
        return;
    }
    console.error('调用失败:', error.message);
    process.exit(1);
});
