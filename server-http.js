import express from 'express';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const PORT = process.env.PORT || 8080;

// Duo設定（オプション - 認証を有効にする場合）
const DUO_ENABLED = process.env.DUO_ENABLED === 'true';
const DUO_TOKEN_INTROSPECTION_ENDPOINT = process.env.DUO_TOKEN_INTROSPECTION_ENDPOINT;
const DUO_CLIENT_ID = process.env.DUO_CLIENT_ID;
const DUO_CLIENT_SECRET = process.env.DUO_CLIENT_SECRET;

if (!SLACK_BOT_TOKEN) {
  console.error('❌ SLACK_BOT_TOKEN environment variable is required');
  process.exit(1);
}

if (DUO_ENABLED && (!DUO_TOKEN_INTROSPECTION_ENDPOINT || !DUO_CLIENT_ID || !DUO_CLIENT_SECRET)) {
  console.error('❌ Duo authentication enabled but required environment variables are missing');
  console.error('   Required: DUO_TOKEN_INTROSPECTION_ENDPOINT, DUO_CLIENT_ID, DUO_CLIENT_SECRET');
  process.exit(1);
}

const app = express();

// JSONボディのパース
app.use(express.json());

// CORS設定（クライアントからのアクセスを許可）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ===== Duo Token Introspection =====
async function verifyDuoToken(token) {
  try {
    const response = await fetch(DUO_TOKEN_INTROSPECTION_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          `${DUO_CLIENT_ID}:${DUO_CLIENT_SECRET}`
        ).toString('base64')
      },
      body: new URLSearchParams({ token })
    });

    if (!response.ok) {
      throw new Error(`Token introspection failed: ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.active) {
      throw new Error('Token is not active');
    }

    return {
      valid: true,
      username: data.username,
      displayName: data.display_name || data.username,
      email: data.email,
      expiresAt: data.exp
    };
  } catch (error) {
    console.error('❌ トークン検証エラー:', error.message);
    return { valid: false };
  }
}

// ===== Extract Token from Authorization Header =====
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

// ===== 認証ミドルウェア =====
async function authenticateRequest(req, res, next) {
  // Duo認証が無効の場合はスキップ
  if (!DUO_ENABLED) {
    req.user = { displayName: 'Anonymous User' };
    return next();
  }

  // トークンを抽出
  const token = extractToken(req);
  if (!token) {
    console.error('❌ トークンが見つかりません');
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Authorization token required'
      }
    });
  }

  // トークンを検証
  console.log('🔍 トークン検証中...');
  const verification = await verifyDuoToken(token);
  
  if (!verification.valid) {
    console.error('❌ トークン検証失敗');
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid or expired token'
      }
    });
  }

  console.log(`✅ 認証成功: ${verification.displayName} (${verification.email})`);
  
  // ユーザー情報をリクエストに追加
  req.user = {
    username: verification.username,
    displayName: verification.displayName,
    email: verification.email
  };

  next();
}

// ヘルスチェック（認証不要）
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    duoEnabled: DUO_ENABLED,
    timestamp: new Date().toISOString()
  });
});

// MCP JSON-RPC エンドポイント（認証必要）
app.post('/mcp', authenticateRequest, async (req, res) => {
  try {
    const request = req.body;
    const userName = req.user.displayName;
    
    console.log(`📨 ${request.method || `id:${request.id}`} (User: ${userName})`);

    let response = null;

    if (request.method === 'initialize') {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { 
            name: 'slack-mcp-http-duo', 
            version: '1.0.0',
            duoEnabled: DUO_ENABLED
          },
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
              description: 'Post a message to Slack (with your username)',
              inputSchema: {
                type: 'object',
                properties: {
                  channel_id: { 
                    type: 'string',
                    description: 'Slack channel ID (e.g., C08286T5HPV)'
                  },
                  text: { 
                    type: 'string',
                    description: 'Message text to post'
                  },
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
      console.log(`🔧 ${name} (User: ${userName})`);

      if (name === 'slack_post_message') {
        try {
          // ユーザー名をメッセージに含める
          const messageText = DUO_ENABLED 
            ? `*[${userName}]* ${args.text}`
            : args.text;

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
                text: messageText,
              }),
            }
          );

          const slackData = await slackResponse.json();

          if (slackData.ok) {
            console.log(`✅ Sent (as ${userName})`);
            const resultMessage = DUO_ENABLED
              ? `Message posted successfully as ${userName}\nChannel: ${args.channel_id}\nTimestamp: ${slackData.ts}`
              : `Sent: "${args.text}"`;
            
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                content: [
                  { type: 'text', text: resultMessage },
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
      console.log(`✅ Client initialized (User: ${userName})`);
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
  console.log('═══════════════════════════════════════');
  console.log('🚀 MCP Server (HTTP with Duo Auth)');
  console.log('═══════════════════════════════════════');
  console.log(`   Port: ${PORT}`);
  console.log(`   HTTP endpoint: POST /mcp`);
  console.log(`   Health check: GET /health`);
  console.log(`   Duo Authentication: ${DUO_ENABLED ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log('\n待機中...\n');
});
