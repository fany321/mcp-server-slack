import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const PORT = process.env.PORT || 10000;

if (!SLACK_BOT_TOKEN) {
  console.error('❌ SLACK_BOT_TOKEN environment variable is required');
  process.exit(1);
}

const app = express();
app.use(express.json());

// CORS設定
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

// SSEエンドポイント
app.get('/sse', async (req, res) => {
  console.log('📡 New SSE connection');
  
  // SSEトランスポートの作成
  const transport = new SSEServerTransport('/message', res);
  
  // MCPサーバーの作成
  const server = new Server(
    {
      name: 'slack-mcp-sse',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ツールリストのハンドラー
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.log('📋 Listing tools');
    return {
      tools: [
        {
          name: 'slack_post_message',
          description: 'Post a message to Slack',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: {
                type: 'string',
                description: 'Slack channel ID',
              },
              text: {
                type: 'string',
                description: 'Message text to post',
              },
            },
            required: ['channel_id', 'text'],
          },
        },
      ],
    };
  });

  // ツール実行のハンドラー
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log('🔧 Calling tool:', name);

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
          console.log('✅ Message sent to Slack');
          return {
            content: [
              {
                type: 'text',
                text: `Successfully sent: "${args.text}"`,
              },
            ],
          };
        } else {
          console.error('❌ Slack error:', slackData.error);
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${slackData.error}`,
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        console.error('❌ Exception:', error.message);
        return {
          content: [
            {
              type: 'text',
              text: `Exception: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  // トランスポートとサーバーを接続
  await server.connect(transport);
  console.log('✅ MCP Server connected via SSE');
});

// クライアント→サーバーメッセージエンドポイント
app.post('/message', (req, res) => {
  // SSEServerTransportが自動的に処理
  // このエンドポイントは存在するだけでOK
  res.sendStatus(202);
});

app.listen(PORT, () => {
  console.log('=== MCP Server (SSE) ===');
  console.log(`🚀 Port ${PORT}`);
  console.log(`📡 SSE endpoint: GET /sse`);
  console.log(`📨 Message endpoint: POST /message`);
});