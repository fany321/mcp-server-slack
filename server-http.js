import express from 'express';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const PORT = process.env.PORT || 8080;

if (!SLACK_BOT_TOKEN) {
  console.error('❌ SLACK_BOT_TOKEN environment variable is required');
  process.exit(1);
}

const app = express();

// JSONボディのパース
app.use(express.json());

// CORS設定（クライアントからのアクセスを許可）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// MCP JSON-RPC エンドポイント
app.post('/mcp', async (req, res) => {
  try {
    const request = req.body;
    console.log('📨', request.method || `id:${request.id}`);

    let response = null;

    if (request.method === 'initialize') {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'slack-mcp-http', version: '1.0.0' },
        },
      };
    }

    else if (request.method === 'tools/list') {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'slack_post_message',
              description: 'Post a message to Slack',
              inputSchema: {
                type: 'object',
                properties: {
                  channel_id: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['channel_id', 'text'],
              },
            },
          ],
        },
      };
    }

    else if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params;
      console.log('🔧', name);

      if (name === 'slack_post_message') {
        try {
          const slackResponse = await fetch(
            'https://slack.com/api/chat.postMessage',
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                channel: args.channel_id,
                text: args.text,
              }),
            }
          );

          const slackData = await slackResponse.json();

          if (slackData.ok) {
            console.log('✅ Sent');
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                content: [
                  { type: 'text', text: `Sent: "${args.text}"` },
                ],
              },
            };
          } else {
            console.log('❌', slackData.error);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                content: [
                  { type: 'text', text: `Error: ${slackData.error}` },
                ],
                isError: true,
              },
            };
          }
        } catch (err) {
          console.error('❌', err.message);
          response = {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32000,
              message: err.message,
            },
          };
        }
      }
    }

    else if (request.method === 'notifications/initialized') {
      console.log('✅ Client initialized');
      // 通知なのでレスポンスは不要、200 OKのみ返す
      return res.sendStatus(200);
    }

    if (response) {
      console.log('📤', response.result ? 'result' : 'error');
      res.json(response);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    }

  } catch (err) {
    console.error('💥', err.message);
    res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
});

app.listen(PORT, () => {
  console.log('=== MCP Server (HTTP) ===');
  console.log(`🚀 Port ${PORT}`);
  console.log(`📡 HTTP endpoint: POST /mcp`);
});
