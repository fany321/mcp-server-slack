import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const PORT = process.env.PORT || 8080;

if (!SLACK_BOT_TOKEN) {
  console.error('❌ SLACK_BOT_TOKEN environment variable is required');
  process.exit(1);
}

const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

console.log('=== MCP Server (Direct) ===');

wss.on('connection', (ws) => {
  console.log('📱 Connected');

  ws.on('message', async (data) => {
    try {
      const request = JSON.parse(data.toString());
      console.log('📨', request.method || `id:${request.id}`);

      let response = null;

      if (request.method === 'initialize') {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'slack-mcp', version: '1.0.0' },
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
        return;
      }

      if (response) {
        ws.send(JSON.stringify(response));
        console.log('📤', response.result ? 'result' : 'error');
      }
    } catch (err) {
      console.error('💥', err.message);
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
      ws.send(JSON.stringify(errorResponse));
    }
  });

  ws.on('error', (err) => console.error('❌ WS:', err.message));
  ws.on('close', () => console.log('📴 Disconnected'));
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Port ${PORT}`);
  console.log(`📡 WebSocket ready`);
});