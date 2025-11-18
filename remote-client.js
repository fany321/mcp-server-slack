import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as readline from 'readline';

const WS_URL = 'ws://localhost:8080';
const CHANNEL_ID = 'C09TCCPN44C';
const CHANNEL_NAME = 'mcp-test';

console.log("=== Remote MCP Client 起動 ===\n");

class WebSocketClientTransport {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this._onmessage = null;
    this._onerror = null;
    this._onclose = null;
  }

  async start() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 ${this.url} に接続中...`);
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log("✅ サーバーに接続しました\n");
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (this._onmessage) {
            this._onmessage(message);
          }
        } catch (error) {
          console.error("メッセージ解析エラー:", error);
        }
      });

      this.ws.on('error', (error) => {
        console.error("WebSocketエラー:", error);
        if (this._onerror) {
          this._onerror(error);
        }
        reject(error);
      });

      this.ws.on('close', () => {
        console.log("📴 サーバーから切断されました");
        if (this._onclose) {
          this._onclose();
        }
      });
    });
  }

  async send(message) {
    this.ws.send(JSON.stringify(message));
  }

  async close() {
    this.ws.close();
  }

  set onmessage(handler) {
    this._onmessage = handler;
  }

  set onerror(handler) {
    this._onerror = handler;
  }

  set onclose(handler) {
    this._onclose = handler;
  }
}

async function main() {
  const transport = new WebSocketClientTransport(WS_URL);

  const client = new Client(
    {
      name: 'remote-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);

  console.log("=== 利用可能なツール ===");
  const tools = await client.listTools();
  tools.tools.forEach((tool) => {
    console.log(`- ${tool.name}`);
  });
  console.log();

  console.log("=== テストメッセージ送信 ===");
  const testResult = await client.callTool({
    name: 'slack_post_message',
    arguments: {
      channel_id: CHANNEL_ID,
      text: '🎉 リモートMCP Server テスト成功！',
    },
  });
  console.log("結果:", testResult.content[0].text);
  console.log("\n✅ Slackを確認してください！\n");

  console.log("========================================");
  console.log("対話モード");
  console.log(`送信先: #${CHANNEL_NAME}`);
  console.log("========================================");
  console.log("メッセージ入力 | 'exit' で終了\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askForMessage = () => {
    rl.question('メッセージ> ', async (input) => {
      if (input.toLowerCase() === 'exit') {
        console.log('\n終了します...');
        rl.close();
        await transport.close();
        process.exit(0);
        return;
      }

      if (!input.trim()) {
        askForMessage();
        return;
      }

      try {
        const result = await client.callTool({
          name: 'slack_post_message',
          arguments: {
            channel_id: CHANNEL_ID,
            text: input,
          },
        });
        console.log('✅', result.content[0].text, '\n');
      } catch (error) {
        console.error('❌ エラー:', error.message, '\n');
      }

      askForMessage();
    });
  };

  askForMessage();
}

main().catch((error) => {
  console.error('エラー:', error);
  process.exit(1);
});