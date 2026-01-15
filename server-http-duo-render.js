import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(bodyParser.json());

// SSE接続管理
const sseConnections = new Map();
let connectionIdCounter = 0;

// OAuth認証セッション管理
const authSessions = new Map();

// 環境変数
const DUO_API_HOSTNAME = process.env.DUO_API_HOSTNAME;
const DUO_CLIENT_ID = process.env.DUO_CLIENT_ID;
const DUO_CLIENT_SECRET = process.env.DUO_CLIENT_SECRET;
const DUO_TOKEN_INTROSPECTION_ENDPOINT = process.env.DUO_TOKEN_INTROSPECTION_ENDPOINT;
const DUO_REDIRECT_URI = process.env.DUO_REDIRECT_URI || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/auth/callback`;

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

// ===== SSE Helper Functions =====
function sendSSE(res, eventType, data) {
  try {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    res.write(message);
  } catch (error) {
    console.error('❌ SSE送信エラー:', error.message);
  }
}

function sendJSONRPCResponse(res, id, result) {
  sendSSE(res, 'message', {
    jsonrpc: '2.0',
    id: id,
    result: result
  });
}

function sendJSONRPCError(res, id, code, message) {
  sendSSE(res, 'message', {
    jsonrpc: '2.0',
    id: id,
    error: {
      code: code,
      message: message
    }
  });
}

// ===== Slack API =====
async function postToSlack(channel, text, username) {
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

  if (!SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN が設定されていません');
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      channel: channel,
      text: `*[${username}]* ${text}`
    })
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.error || 'Slack API エラー');
  }

  return data;
}

// ===== OAuth Authentication Endpoints =====

// 1. 認証開始
app.get('/auth/duo-initiate', (req, res) => {
  if (!DUO_API_HOSTNAME || !DUO_CLIENT_ID) {
    return res.status(500).json({ error: 'Duo OAuth not configured' });
  }

  const state = crypto.randomBytes(32).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // セッション保存
  authSessions.set(state, {
    codeVerifier,
    timestamp: Date.now(),
    authenticated: false
  });

  // 古いセッションをクリーンアップ（10分以上前）
  for (const [key, value] of authSessions.entries()) {
    if (Date.now() - value.timestamp > 10 * 60 * 1000) {
      authSessions.delete(key);
    }
  }

  const authUrl = `https://${DUO_API_HOSTNAME}/oauth/v1/authorize?` +
    `response_type=code&` +
    `client_id=${encodeURIComponent(DUO_CLIENT_ID)}&` +
    `redirect_uri=${encodeURIComponent(DUO_REDIRECT_URI)}&` +
    `state=${state}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256&` +
    `scope=openid`;

  console.log('🔑 認証URL生成:', state);
  res.json({ authUrl, state });
});

// 2. コールバック処理
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send('Missing code or state parameter');
  }

  const session = authSessions.get(state);
  if (!session) {
    return res.status(400).send('Invalid or expired session');
  }

  try {
    console.log('🔄 トークン交換中...');
    
    // トークン交換
    const tokenResponse = await fetch(`https://${DUO_API_HOSTNAME}/oauth/v1/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${DUO_CLIENT_ID}:${DUO_CLIENT_SECRET}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: DUO_REDIRECT_URI,
        code_verifier: session.codeVerifier
      })
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} - ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    
    // セッションを更新
    session.authenticated = true;
    session.accessToken = tokenData.access_token;
    session.refreshToken = tokenData.refresh_token;
    session.expiresAt = Date.now() + (tokenData.expires_in * 1000);

    console.log('✅ 認証成功！');

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Successful</title>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              padding: 40px; 
              text-align: center; 
              background: #f5f5f5;
            }
            .container {
              background: white;
              border-radius: 8px;
              padding: 40px;
              max-width: 500px;
              margin: 0 auto;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .success { 
              color: #28a745; 
              font-size: 48px; 
              margin: 20px 0; 
            }
            .title {
              font-size: 24px;
              font-weight: bold;
              margin: 20px 0;
            }
            .info { 
              color: #666; 
              margin: 20px 0;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✓</div>
            <div class="title">Authentication Successful!</div>
            <div class="info">You can now close this window and return to your terminal.</div>
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('❌ 認証エラー:', error.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authentication Failed</title></head>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h1 style="color: #dc3545;">Authentication Failed</h1>
          <p>${error.message}</p>
        </body>
      </html>
    `);
  }
});

// 3. 認証状態確認
app.get('/auth/status', (req, res) => {
  const { state } = req.query;

  if (!state) {
    return res.status(400).json({ error: 'Missing state parameter' });
  }

  const session = authSessions.get(state);
  if (!session) {
    return res.json({ authenticated: false, error: 'Session not found' });
  }

  res.json({
    authenticated: session.authenticated,
    token: session.authenticated ? session.accessToken : undefined,
    expiresAt: session.expiresAt
  });
});

// ===== Health Check Endpoint =====
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    duoOAuthConfigured: !!(DUO_API_HOSTNAME && DUO_CLIENT_ID),
    timestamp: new Date().toISOString() 
  });
});

// ===== GET /mcp - SSE接続確立 =====
app.get('/mcp', async (req, res) => {
  console.log('\n📡 GET /mcp - 新しい接続リクエスト');

  // トークン検証
  const token = extractToken(req);
  if (!token) {
    console.error('❌ トークンが見つかりません');
    return res.status(401).json({ error: 'Authorization token required' });
  }

  console.log('🔍 トークン検証中...');
  const verification = await verifyDuoToken(token);

  if (!verification.valid) {
    console.error('❌ トークン検証失敗');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  console.log(`✅ 認証成功: ${verification.displayName} (${verification.email})`);

  // 接続IDを生成
  const connectionId = ++connectionIdCounter;

  // SSEヘッダー設定
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // SSE接続を保存（ユーザー情報と共に）
  sseConnections.set(connectionId, {
    res: res,
    user: {
      username: verification.username,
      displayName: verification.displayName,
      email: verification.email
    },
    connectedAt: Date.now()
  });

  console.log(`📡 SSE接続確立 (ID: ${connectionId})`);
  console.log(`   現在のSSE接続数: ${sseConnections.size}`);

  // 初期接続確認メッセージ
  sendSSE(res, 'endpoint', {
    path: '/mcp',
    connectionId: connectionId,
    authenticated: true,
    user: verification.displayName
  });

  // クライアント切断時の処理
  req.on('close', () => {
    console.log(`🔌 SSE接続切断 (ID: ${connectionId})`);
    sseConnections.delete(connectionId);
  });
});

// ===== POST /mcp - JSON-RPCメッセージ処理 =====
app.post('/mcp', async (req, res) => {
  console.log('\n📨 POST /mcp - メッセージ受信');

  const message = req.body;
  console.log('   Method:', message.method);
  console.log('   ID:', message.id);

  // トークン検証
  const token = extractToken(req);
  if (!token) {
    console.error('❌ トークンが見つかりません');
    return res.status(401).json({ error: 'Authorization token required' });
  }

  const verification = await verifyDuoToken(token);
  if (!verification.valid) {
    console.error('❌ トークン検証失敗');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // 対応するSSE接続を探す（同じユーザーの最新の接続）
  let targetConnection = null;
  for (const [id, conn] of sseConnections.entries()) {
    if (conn.user.email === verification.email) {
      targetConnection = conn;
      break;
    }
  }

  if (!targetConnection) {
    console.error('❌ SSE接続が見つかりません');
    return res.status(404).json({ error: 'No active SSE connection found. Please establish GET /mcp connection first.' });
  }

  const sseRes = targetConnection.res;
  const userName = targetConnection.user.displayName;

  try {
    // JSON-RPCメッセージを処理
    if (message.method === 'initialize') {
      console.log('🔧 Initialize リクエスト処理中...');

      sendJSONRPCResponse(sseRes, message.id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'slack-mcp-server-duo',
          version: '1.0.0'
        }
      });

      console.log('✅ Initialize レスポンス送信完了');
      return res.status(200).json({ status: 'ok' });
    }

    if (message.method === 'tools/list') {
      console.log('🔧 Tools/List リクエスト処理中...');

      sendJSONRPCResponse(sseRes, message.id, {
        tools: [
          {
            name: 'postMessage',
            description: 'Slackチャンネルにメッセージを投稿します（ユーザー名付き）',
            inputSchema: {
              type: 'object',
              properties: {
                channel: {
                  type: 'string',
                  description: 'チャンネルID（例: C08286T5HPV）'
                },
                text: {
                  type: 'string',
                  description: '投稿するメッセージ'
                }
              },
              required: ['channel', 'text']
            }
          }
        ]
      });

      console.log('✅ Tools/List レスポンス送信完了');
      return res.status(200).json({ status: 'ok' });
    }

    if (message.method === 'tools/call') {
      console.log('🔧 Tools/Call リクエスト処理中...');

      const toolName = message.params?.name;
      const args = message.params?.arguments;

      if (toolName === 'postMessage') {
        const { channel, text } = args;

        console.log(`📤 Slack投稿: ${userName} -> #${channel}`);
        console.log(`   メッセージ: ${text.substring(0, 50)}...`);

        const result = await postToSlack(channel, text, userName);

        sendJSONRPCResponse(sseRes, message.id, {
          content: [
            {
              type: 'text',
              text: `メッセージを投稿しました（${userName}として）\nチャンネル: ${channel}\nタイムスタンプ: ${result.ts}`
            }
          ]
        });

        console.log('✅ Tools/Call レスポンス送信完了');
        return res.status(200).json({ status: 'ok' });
      } else {
        sendJSONRPCError(sseRes, message.id, -32601, `Unknown tool: ${toolName}`);
        return res.status(400).json({ error: 'Unknown tool' });
      }
    }

    // 通知メッセージ（notifications/*）は応答不要
    if (message.method && message.method.startsWith('notifications/')) {
      console.log(`📢 通知受信: ${message.method}`);
      return res.status(200).json({ status: 'ok' });
    }

    // 不明なメソッド
    console.error('❌ 不明なメソッド:', message.method);
    sendJSONRPCError(sseRes, message.id, -32601, 'Method not found');
    return res.status(400).json({ error: 'Method not found' });

  } catch (error) {
    console.error('❌ メッセージ処理エラー:', error);
    sendJSONRPCError(sseRes, message.id, -32603, error.message);
    return res.status(500).json({ error: error.message });
  }
});

// SSE接続クリーンアップ（10分ごと）
setInterval(() => {
  const now = Date.now();
  for (const [connectionId, conn] of sseConnections.entries()) {
    // 1時間以上接続されている場合は削除
    if (now - conn.connectedAt > 3600000) {
      console.log(`🧹 期限切れSSE接続削除: ${connectionId}`);
      sseConnections.delete(connectionId);
    }
  }
}, 600000);

// ===== サーバー起動 =====
app.listen(port, () => {
  console.log('═══════════════════════════════════════');
  console.log('🚀 MCP Server with Duo OAuth + Token Verification');
  console.log('═══════════════════════════════════════');
  console.log(`   ポート: ${port}`);
  console.log(`   エンドポイント: /mcp`);
  console.log(`   認証方式: Duo OAuth + Token Introspection`);
  console.log(`   Health Check: /health`);
  console.log(`   OAuth initiate: /auth/duo-initiate`);
  console.log(`   OAuth callback: /auth/callback`);
  console.log(`   OAuth status: /auth/status`);
  console.log('\n待機中...\n');
});
