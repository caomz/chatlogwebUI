require('dotenv').config();

// 启动时一次性迁移:如果 model-settings.json 里还有 apiKey 字段,剥掉。
// 这是"key 永远在 .env"改造的兼容层:旧版本可能把 key 写进了 json。
// 只在第一次启动时跑(下次启动 json 已经被剥干净,跳过)。
try {
  const modelSettingsPath = require('path').join(__dirname, 'model-settings.json');
  if (require('fs').existsSync(modelSettingsPath)) {
    const raw = JSON.parse(require('fs').readFileSync(modelSettingsPath, 'utf8'));
    let touched = false;
    for (const k of ['deepseek', 'gemini', 'minimax']) {
      if (raw[k] && Object.prototype.hasOwnProperty.call(raw[k], 'apiKey')) {
        delete raw[k].apiKey;
        touched = true;
      }
    }
    if (touched) {
      require('fs').writeFileSync(modelSettingsPath, JSON.stringify(raw, null, 2));
      console.log('🧹 启动迁移:已从 model-settings.json 移除 apiKey 字段(已废弃,key 仅存在 .env)');
    }
  }
} catch (migErr) {
  console.warn('model-settings.json 迁移失败(非致命):', migErr.message);
}

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const moment = require('moment');
const fs = require('fs');
const cron = require('node-cron');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const CHATLOG_API_BASE = 'http://127.0.0.1:5030/api/v1';

function parsePositiveIntEnv(name, defaultValue) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

// API key 统一读取函数
// 单一事实源:.env(经 dotenv.config() 加载到 process.env)
// 任何代码路径读取 key 都必须走这里,禁止从 model-settings.json 读 apiKey。
function getEnvApiKey(providerKey) {
  switch (providerKey) {
    case 'deepseek': return process.env.DEEPSEEK_API_KEY || '';
    case 'gemini':   return process.env.GEMINI_API_KEY   || '';
    case 'minimax':  return process.env.MINIMAX_API_KEY  || '';
    default:         return '';
  }
}

// DeepSeek API配置
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'your-deepseek-api-key-here';
const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const MINIMAX_API_BASE = 'https://api.minimaxi.com/v1';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7';
const MODEL_TEST_TIMEOUT_MS = 30000;
const MODEL_TEST_MAX_RETRIES = 2;
const AI_CALL_TIMEOUT_MS = parsePositiveIntEnv('AI_CALL_TIMEOUT_MS', 600000);
const AI_CALL_LARGE_PROMPT_THRESHOLD = parsePositiveIntEnv('AI_CALL_LARGE_PROMPT_THRESHOLD', 50000);
const AI_CALL_LARGE_TIMEOUT_MS = parsePositiveIntEnv('AI_CALL_LARGE_TIMEOUT_MS', 900000);
const AI_CALL_MAX_RETRIES = parsePositiveIntEnv('AI_CALL_MAX_RETRIES', 4);
const AI_RETRY_BASE_DELAY_MS = parsePositiveIntEnv('AI_RETRY_BASE_DELAY_MS', 30000);
const AI_RETRY_MAX_DELAY_MS = parsePositiveIntEnv('AI_RETRY_MAX_DELAY_MS', 180000);
const MMX_IMAGE_ANALYSIS_ENABLED = process.env.MMX_IMAGE_ANALYSIS_ENABLED !== 'false';
const MMX_IMAGE_ANALYSIS_LIMIT = parseInt(process.env.MMX_IMAGE_ANALYSIS_LIMIT || '30', 10);
const MMX_IMAGE_ANALYSIS_RETRIES = parseInt(process.env.MMX_IMAGE_ANALYSIS_RETRIES || '2', 10);
// 图片识别失败的负缓存有效期（默认 24h）：TTL 内不重复重试，过期后允许重试，避免把 vision 后端间歇性故障永久化
const MMX_IMAGE_NEG_CACHE_TTL_MS = parseInt(process.env.MMX_IMAGE_NEG_CACHE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const MMX_IMAGE_ANALYSIS_TIMEOUT_MS = parseInt(process.env.MMX_IMAGE_ANALYSIS_TIMEOUT_MS || '120000', 10);
const MMX_IMAGE_ANALYSIS_CACHE_DIR = path.join(__dirname, '.cache', 'mmx-image-analysis');

// 定时任务配置 - 使用动态变量
const ANALYSIS_INTERVAL_MIN_SECONDS = 1;
const ANALYSIS_INTERVAL_MAX_SECONDS = 300; // 最大5分钟
const ANALYSIS_INTERVAL_DEFAULT_SECONDS = 3;

function normalizeAnalysisIntervalSeconds(value) {
  const interval = parseInt(value, 10);
  if (!Number.isFinite(interval)) return ANALYSIS_INTERVAL_DEFAULT_SECONDS;
  return Math.min(
    ANALYSIS_INTERVAL_MAX_SECONDS,
    Math.max(ANALYSIS_INTERVAL_MIN_SECONDS, interval)
  );
}

let SCHEDULED_ANALYSIS_TIME = process.env.SCHEDULED_ANALYSIS_TIME || '0 0 8 * * *'; // 默认每天早上8点
let ENABLE_SCHEDULED_ANALYSIS = process.env.ENABLE_SCHEDULED_ANALYSIS === 'true';
let ANALYSIS_INTERVAL = normalizeAnalysisIntervalSeconds(process.env.ANALYSIS_INTERVAL);
let currentCronJob = null; // 保存当前的定时任务实例

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 设置模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 配置moment中文支持
moment.locale('zh-cn');

// Chatlog v1 API 数据解析工具函数
function parseJSONResponse(data) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (e) {
      return {};
    }
  }
  return data || {};
}

function formatLocalDate(date) {
  return moment(date).format('YYYY-MM-DD');
}

function normalizeChatlogTime(time) {
  if (!time) return '';
  if (String(time).includes('~')) return time;

  const today = moment();
  const timeMap = {
    recent: [moment().subtract(7, 'days'), today],
    today: [today, today],
    yesterday: [moment().subtract(1, 'day'), moment().subtract(1, 'day')],
    week: [moment().subtract(7, 'days'), today],
    month: [moment().subtract(1, 'month'), today],
    year: [moment().subtract(1, 'year'), today],
    // 常见别名：最近3天（兼容历史配置里写入的 last_3_days 等）
    last_3_days: [moment().subtract(3, 'days'), today],
    last3days: [moment().subtract(3, 'days'), today],
    '3days': [moment().subtract(3, 'days'), today],
    recent_3_days: [moment().subtract(3, 'days'), today],
    // 全部时间
    all: [moment('2020-01-01'), today],
    all_time: [moment('2020-01-01'), today],
    '全部': [moment('2020-01-01'), today]
  };

  const range = timeMap[time];
  if (!range) {
    // 未知时间关键词不再原样透传（透传会导致 chatlog 返回 400/500），回退到安全默认（最近7天）
    console.warn(`normalizeChatlogTime: 未知时间关键词 "${time}"，回退到最近7天`);
    const fallback = [moment().subtract(7, 'days'), today];
    return `${formatLocalDate(fallback[0])}~${formatLocalDate(fallback[1])}`;
  }
  return `${formatLocalDate(range[0])}~${formatLocalDate(range[1])}`;
}

function extractMessages(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.records)) return data.records;
  return [];
}

function getDefaultModelSettings() {
  // apiKey 永远为空串:不要在 default 里写真 key。
  // 真实 key 由 getEnvApiKey(providerKey) 在调用时从 process.env 读。
  return {
    modelProvider: 'DeepSeek',
    deepseek: {
      model: process.env.DEEPSEEK_MODEL || 'deepseek-reasoner',
      apiKey: ''
    },
    gemini: {
      model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
      apiKey: ''
    },
    minimax: {
      model: MINIMAX_MODEL,
      apiKey: ''
    }
  };
}

function normalizeModelSettings(rawSettings = {}) {
  const defaults = getDefaultModelSettings();
  const providers = ['DeepSeek', 'Gemini', 'MiniMax'];
  const modelProvider = providers.includes(rawSettings.modelProvider) ? rawSettings.modelProvider : defaults.modelProvider;

  return {
    modelProvider,
    deepseek: { ...defaults.deepseek, ...(rawSettings.deepseek || {}) },
    gemini: { ...defaults.gemini, ...(rawSettings.gemini || {}) },
    minimax: { ...defaults.minimax, ...(rawSettings.minimax || {}) }
  };
}

function getProviderKey(provider) {
  if (provider === 'DeepSeek') return 'deepseek';
  if (provider === 'Gemini') return 'gemini';
  if (provider === 'MiniMax') return 'minimax';
  return null;
}

// 转换联系人数据格式 (适配 Chatlog v1 API)
function formatContactData(contacts) {
  return contacts.map(contact => ({
    wxid: contact.username || contact.name || contact.wxid || '',
    displayName: contact.display || contact.remark || contact.nickname || contact.alias || contact.username || contact.name || '未知联系人',
    nickname: contact.nickname || '',
    remark: contact.remark || '',
    alias: contact.alias || '',
    isFriend: contact.is_friend || false
  })).filter(contact => contact.wxid); // 过滤掉没有wxid的数据
}

// 转换群聊数据格式 (适配 Chatlog v1 API)
function formatChatroomData(chatrooms) {
  return chatrooms.map(chatroom => ({
    wxid: chatroom.name || chatroom.username || chatroom.wxid || '',
    displayName: chatroom.display || chatroom.remark || chatroom.nickname || chatroom.name || chatroom.username || '未知群聊',
    nickname: chatroom.nickname || '',
    remark: chatroom.remark || '',
    owner: chatroom.owner || '',
    userCount: chatroom.user_count || 0
  })).filter(chatroom => chatroom.wxid); // 过滤掉没有wxid的数据
}

// 转换最近会话数据格式 (适配 Chatlog v1 API)
function formatSessionData(sessions) {
  return sessions.map(session => ({
    wxid: session.username || session.name || session.wxid || '',
    displayName: session.chat || session.display || session.remark || session.nickname || session.username || '未知会话',
    nickname: session.nickname || '',
    remark: session.remark || '',
    summary: session.summary || '',
    time: session.time || '',
    timestamp: session.timestamp || '',
    isGroup: Boolean(session.is_group || session.isGroup),
    chatType: session.chat_type || session.chatType || ''
  })).filter(session => session.wxid);
}

// 首页路由
app.get('/', (req, res) => {
  res.render('index');
});

// API代理路由
// 获取聊天记录 (适配 Chatlog v1 API)
app.get('/api/chatlog', async (req, res) => {
  try {
    const { time, talker, limit, offset = 0, format = 'json' } = req.query;

    const params = new URLSearchParams();
    // Chatlog v1 使用 'chat' 参数而不是 'talker'
    if (talker) params.append('chat', talker);

    // 时间参数处理：Chatlog v1 对 week/month 等关键词不稳定，统一转为日期范围
    if (time) {
      params.append('time', normalizeChatlogTime(time));
    }
    
    // 只有当明确指定limit时才添加该参数（支持不限制查询）
    if (limit !== undefined && limit !== '') {
      params.append('limit', limit);
    }
    
    if (offset) params.append('offset', offset);
    if (format) params.append('format', format);

    console.log('请求聊天记录 API:', `${CHATLOG_API_BASE}/history?${params}`);
    
    const response = await axios.get(`${CHATLOG_API_BASE}/history?${params}`);
    
    // 调试：记录原始响应
    const jsonData = parseJSONResponse(response.data);
    const messages = extractMessages(jsonData);
    if (messages.length > 0) {
      console.log('聊天记录原始数据示例:', JSON.stringify(messages[0], null, 2));
      console.log('数据字段:', Object.keys(messages[0]));
    } else {
      console.log('返回数据格式:', typeof response.data, jsonData);
    }
    
    res.json(messages);
  } catch (error) {
    console.error('获取聊天记录失败:', error.message);
    if (error.response) {
      console.error('API错误响应:', error.response.status, error.response.data);
    }
    res.status(500).json({ 
      error: '获取聊天记录失败', 
      message: error.response?.data?.message || error.message 
    });
  }
});

// 获取联系人列表
app.get('/api/contacts', async (req, res) => {
  try {
    const response = await axios.get(`${CHATLOG_API_BASE}/contacts?format=json`);
    const jsonData = parseJSONResponse(response.data);
    const contacts = jsonData.contacts || [];
    const formattedData = formatContactData(contacts);
    
    console.log(`获取到 ${formattedData.length} 个联系人`);
    res.json(formattedData);
  } catch (error) {
    console.error('获取联系人列表失败:', error.message);
    res.status(500).json({ 
      error: '获取联系人列表失败', 
      message: error.response?.data?.message || error.message 
    });
  }
});

// 获取群聊列表
app.get('/api/chatrooms', async (req, res) => {
  try {
    const response = await axios.get(`${CHATLOG_API_BASE}/chatrooms?format=json`);
    const jsonData = parseJSONResponse(response.data);
    const chatrooms = jsonData.chatrooms || [];
    const formattedData = formatChatroomData(chatrooms);
    
    console.log(`获取到 ${formattedData.length} 个群聊`);
    res.json(formattedData);
  } catch (error) {
    console.error('获取群聊列表失败:', error.message);
    res.status(500).json({ 
      error: '获取群聊列表失败', 
      message: error.response?.data?.message || error.message 
    });
  }
});

// 获取会话列表
app.get('/api/sessions', async (req, res) => {
  try {
    const response = await axios.get(`${CHATLOG_API_BASE}/sessions?format=json`);
    const jsonData = parseJSONResponse(response.data);
    const sessions = Array.isArray(jsonData)
      ? jsonData
      : (Array.isArray(jsonData.sessions) ? jsonData.sessions : []);
    const formattedData = formatSessionData(sessions);

    console.log(`获取到 ${formattedData.length} 个最近会话`);
    res.json(formattedData);
  } catch (error) {
    console.error('获取会话列表失败:', error.message);
    res.status(500).json({ 
      error: '获取会话列表失败', 
      message: error.response?.data?.message || error.message 
    });
  }
});

// 获取多媒体内容
app.get('/api/media', async (req, res) => {
  try {
    const { msgid } = req.query;
    if (!msgid) {
      return res.status(400).json({ error: '缺少消息ID参数' });
    }

    const response = await axios.get(`${CHATLOG_API_BASE}/media?msgid=${msgid}`, {
      responseType: 'stream'
    });
    
    // 设置响应头
    if (response.headers['content-type']) {
      res.set('Content-Type', response.headers['content-type']);
    }
    
    response.data.pipe(res);
  } catch (error) {
    console.error('获取多媒体内容失败:', error.message);
    res.status(500).json({ 
      error: '获取多媒体内容失败', 
      message: error.response?.data?.message || error.message 
    });
  }
});

// 历史记录管理
const HISTORY_DIR = path.join(__dirname, 'ai_analysis_history');
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// 保存分析历史记录
function saveAnalysisHistory(metadata, analysisContent) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${metadata.groupName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}_${metadata.timeRange.replace(/[^0-9-]/g, '_')}_${timestamp}.json`;
  const filepath = path.join(HISTORY_DIR, filename);
  
  const historyRecord = {
    ...metadata,
    content: analysisContent,
    savedAt: new Date().toISOString()
  };
  
  fs.writeFileSync(filepath, JSON.stringify(historyRecord, null, 2), 'utf8');
  return filename.replace('.json', '');
}

// 获取分析历史记录列表
function getAnalysisHistory() {
  try {
    const files = fs.readdirSync(HISTORY_DIR)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const filepath = path.join(HISTORY_DIR, file);
        const content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        return {
          id: file.replace('.json', ''),
          title: `${content.groupName} - ${content.timeRange}`,
          timestamp: content.savedAt,
          analysisType: content.analysisType,
          messageCount: content.messageCount,
          groupName: content.groupName,
          timeRange: content.timeRange
        };
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return files;
  } catch (error) {
    console.error('获取历史记录失败:', error);
    return [];
  }
}

// AI分析相关函数
async function getChatData(talker, timeRange = '2024-01-01~2025-12-31') {
  try {
    const params = new URLSearchParams();
    params.append('time', normalizeChatlogTime(timeRange));
    // Chatlog v1 history 接口要求使用 chat 参数
    params.append('chat', talker);
    params.append('limit', '500'); // 获取更多数据用于分析
    params.append('format', 'json');

    const response = await axios.get(`${CHATLOG_API_BASE}/history?${params}`);
    const jsonData = parseJSONResponse(response.data);
    const messages = extractMessages(jsonData);
    const chatName = jsonData.chat || talker;

    // 统一为分析模板所需字段，兼容 chatlog v1 与旧格式
    return messages.map((msg) => {
      const sender = msg.senderName || msg.sender || msg.from || '未知用户';
      const content = typeof msg.content === 'string' ? msg.content : '';
      const time = msg.time || (msg.timestamp ? moment.unix(msg.timestamp).format('YYYY-MM-DD HH:mm:ss') : '');

      return {
        ...msg,
        senderName: sender,
        talkerName: msg.talkerName || chatName,
        content,
        time
      };
    });
  } catch (error) {
    console.error('获取聊天数据失败:', error.message);
    throw error;
  }
}

// 探测某群是否有过任何聊天记录及最近消息日期，用于区分「群名无效」与「所选时段无数据」。
// 仅在主查询为空时调用；自身错误不外抛（返回 hasAnyMessage:null 让调用方回退）。
async function probeGroupActivity(talker) {
  try {
    const params = new URLSearchParams();
    params.append('time', '2020-01-01~' + formatLocalDate(moment()));
    params.append('chat', talker);
    params.append('limit', '500');
    params.append('format', 'json');
    const response = await axios.get(`${CHATLOG_API_BASE}/history?${params}`);
    const messages = extractMessages(parseJSONResponse(response.data));
    if (!messages || messages.length === 0) {
      return { hasAnyMessage: false, latestDate: null, sampleCount: 0 };
    }
    let latest = '';
    for (const m of messages) {
      const t = m.time || (m.timestamp ? moment.unix(m.timestamp).format('YYYY-MM-DD HH:mm:ss') : '');
      if (t && t > latest) latest = t;
    }
    const latestDate = latest ? String(latest).slice(0, 10) : null;
    return { hasAnyMessage: true, latestDate, sampleCount: messages.length };
  } catch (error) {
    console.warn(`probeGroupActivity 失败 (${talker}): ${error.message}`);
    return { hasAnyMessage: null, latestDate: null, sampleCount: 0, probeError: error.message };
  }
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getMessageType(msg) {
  return msg.type || msg.Type || msg.MsgType || msg.msgType || msg.msg_type || msg.messageType || '';
}

function getMessageContent(msg) {
  const content = msg.content || msg.message || msg.Content || msg.Message || msg.StrContent || '';
  return typeof content === 'string' ? content : '';
}

function getMessageMediaId(msg) {
  return msg.msgId || msg.msgid || msg.msgID || msg.MsgId || msg.MsgID || msg.id || msg.ID || '';
}

function getImageSourceUrl(msg) {
  const directUrl = msg.url || msg.mediaUrl || msg.imageUrl || msg.src || '';
  if (directUrl) return String(directUrl);

  const content = getMessageContent(msg);
  const markdownImage = content.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (markdownImage?.[1]) return markdownImage[1];

  const imageUrl = content.match(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i);
  return imageUrl?.[0] || '';
}

function isImageMessage(msg) {
  const type = getMessageType(msg);
  const normalizedType = String(type).toLowerCase();
  const contentType = String(msg.contentType || msg.mimeType || msg.mime_type || '').toLowerCase();
  const content = getMessageContent(msg).toLowerCase();

  return normalizedType === 'image'
    || normalizedType === 'img'
    || type === 3
    || normalizedType === '3'
    || contentType.startsWith('image/')
    || content.includes('<img')
    || content.includes('[图片]');
}

function getImageCacheKey(msg) {
  const mediaId = String(getMessageMediaId(msg) || '').trim();
  if (mediaId) {
    return mediaId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  }

  const fingerprint = JSON.stringify({
    sender: msg.senderName || msg.sender || '',
    time: msg.time || msg.timestamp || '',
    type: getMessageType(msg),
    content: getMessageContent(msg)
  });
  return crypto.createHash('sha256').update(fingerprint).digest('hex');
}

function getImageExtension(contentType = '') {
  const normalized = String(contentType).toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  return 'jpg';
}

function findCachedImage(cacheKey) {
  if (!fs.existsSync(MMX_IMAGE_ANALYSIS_CACHE_DIR)) return null;
  const prefix = `${cacheKey}.`;
  const filename = fs.readdirSync(MMX_IMAGE_ANALYSIS_CACHE_DIR)
    .find(item => item.startsWith(prefix) && !item.endsWith('.json'));
  return filename ? path.join(MMX_IMAGE_ANALYSIS_CACHE_DIR, filename) : null;
}

function extractMmxVisionText(rawOutput) {
  const trimmed = String(rawOutput || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (parsed.text) return parsed.text;
    if (parsed.content) return parsed.content;
    if (parsed.description) return parsed.description;
    if (parsed.output) return typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output);
    if (parsed.response) return typeof parsed.response === 'string' ? parsed.response : JSON.stringify(parsed.response);
    if (parsed.choices?.[0]?.message?.content) return parsed.choices[0].message.content;
    if (parsed.data?.choices?.[0]?.message?.content) return parsed.data.choices[0].message.content;
    return JSON.stringify(parsed);
  } catch (error) {
    return trimmed;
  }
}

async function downloadImageForMmx(msg) {
  const msgid = getMessageMediaId(msg);
  const sourceUrl = getImageSourceUrl(msg);
  if (!msgid && !sourceUrl) {
    throw new Error('图片消息缺少 msgid 或图片 URL，无法从 Chatlog 获取媒体内容');
  }

  fs.mkdirSync(MMX_IMAGE_ANALYSIS_CACHE_DIR, { recursive: true });

  const cacheKey = getImageCacheKey(msg);
  const cachedImage = findCachedImage(cacheKey);
  if (cachedImage) return { cacheKey, imagePath: cachedImage, fromCache: true };

  const mediaUrl = msgid
    ? `${CHATLOG_API_BASE}/media?msgid=${encodeURIComponent(msgid)}`
    : sourceUrl;
  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 60000
  });

  const contentType = response.headers['content-type'] || '';
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Chatlog 返回的媒体类型不是图片: ${contentType}`);
  }

  const imagePath = path.join(MMX_IMAGE_ANALYSIS_CACHE_DIR, `${cacheKey}.${getImageExtension(contentType)}`);
  fs.writeFileSync(imagePath, Buffer.from(response.data));
  return { cacheKey, imagePath, fromCache: false };
}

async function describeImageWithMmx(imagePath) {
  const prompt = [
    '请识别这张聊天图片的内容，输出中文。',
    '重点提取：截图里的文字、界面/表格/图表信息、人物或物体、关键结论、与群聊上下文可能相关的事实。',
    '如果图片无法判断，请明确说明不确定点。不要编造。'
  ].join('');

  const args = [
    'vision',
    'describe',
    '--image',
    imagePath,
    '--prompt',
    prompt,
    '--non-interactive',
    '--quiet',
    '--output',
    'json',
    '--timeout',
    String(Math.ceil(MMX_IMAGE_ANALYSIS_TIMEOUT_MS / 1000))
  ];

  const { stdout } = await execFileAsync('mmx', args, {
    cwd: __dirname,
    timeout: MMX_IMAGE_ANALYSIS_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 8
  });

  const description = extractMmxVisionText(stdout).replace(/\s+/g, ' ').trim();
  if (!description) {
    throw new Error('mmx vision describe 未返回可用识别文本');
  }

  return description.slice(0, 2000);
}

// 图片识别失败的负缓存：文件名与正向缓存（<cacheKey>.json）分离，避免被当成成功结果读取
function negativeImageCachePath(cacheKey) {
  return path.join(MMX_IMAGE_ANALYSIS_CACHE_DIR, `${cacheKey}.failed.json`);
}

// 读负缓存：存在且未过期 → 返回 { error, failedAt }；不存在或已过期（过期则删除）→ null
function readNegativeImageCache(cacheKey) {
  try {
    const p = negativeImageCachePath(cacheKey);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const age = Date.now() - new Date(data.failedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < MMX_IMAGE_NEG_CACHE_TTL_MS) return data;
    fs.unlinkSync(p); // 已过期：删除以允许重新识别
    return null;
  } catch (e) {
    return null;
  }
}

// 写负缓存：记录失败原因与时间戳；写失败不影响主流程
function writeNegativeImageCache(cacheKey, error) {
  try {
    fs.mkdirSync(MMX_IMAGE_ANALYSIS_CACHE_DIR, { recursive: true });
    const safeError = String((error && (error.stderr || error.message)) || error || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    fs.writeFileSync(
      negativeImageCachePath(cacheKey),
      JSON.stringify({ success: false, error: safeError, failedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (e) {
    console.warn(`写图片负缓存失败 (${cacheKey}): ${e.message}`);
  }
}

async function analyzeImageMessageWithMmx(msg) {
  const cacheKey = getImageCacheKey(msg);
  const resultPath = path.join(MMX_IMAGE_ANALYSIS_CACHE_DIR, `${cacheKey}.json`);

  if (fs.existsSync(resultPath)) {
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  }

  const { imagePath } = await downloadImageForMmx(msg);
  const description = await describeImageWithMmx(imagePath);
  const result = {
    success: true,
    description,
    imagePath,
    analyzedAt: new Date().toISOString(),
    tool: 'mmx vision describe'
  };

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

async function analyzeImageMessageWithRetry(msg) {
  const cacheKey = getImageCacheKey(msg);
  // 负缓存命中（TTL 内）：跳过下载与重试，直接按失败处理，避免重复浪费 mmx 调用
  const negative = readNegativeImageCache(cacheKey);
  if (negative) {
    throw new Error(`图片近期识别失败(${negative.failedAt})，命中负缓存跳过重试: ${negative.error}`);
  }

  const maxAttempts = Number.isFinite(MMX_IMAGE_ANALYSIS_RETRIES) && MMX_IMAGE_ANALYSIS_RETRIES > 0
    ? MMX_IMAGE_ANALYSIS_RETRIES
    : 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`🔁 重试图片识别 (${attempt}/${maxAttempts}): ${getMessageMediaId(msg) || getImageCacheKey(msg)}`);
      }
      return await analyzeImageMessageWithMmx(msg);
    } catch (error) {
      lastError = error;
      const safeError = String(error.stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 500);
      console.error(`⚠️ 图片识别失败 (${attempt}/${maxAttempts}): ${getMessageMediaId(msg) || getImageCacheKey(msg)} - ${safeError}`);
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
  }

  // 所有尝试失败：写负缓存，TTL 内不再重复重试同一张图
  writeNegativeImageCache(cacheKey, lastError);
  throw lastError;
}

async function enrichChatDataWithImageDescriptions(chatData) {
  if (!MMX_IMAGE_ANALYSIS_ENABLED) {
    return chatData;
  }

  const imageMessages = chatData.filter(isImageMessage);
  if (imageMessages.length === 0) {
    return chatData;
  }

  console.log(`🖼️ 检测到 ${imageMessages.length} 条图片消息，开始调用 mmx 识别图片内容`);

  let analyzedCount = 0;
  const limit = Number.isFinite(MMX_IMAGE_ANALYSIS_LIMIT) && MMX_IMAGE_ANALYSIS_LIMIT > 0
    ? MMX_IMAGE_ANALYSIS_LIMIT
    : 30;

  const enriched = [];
  for (const msg of chatData) {
    if (!isImageMessage(msg)) {
      enriched.push(msg);
      continue;
    }

    const originalContent = getMessageContent(msg).trim();
    if (analyzedCount >= limit) {
      enriched.push({
        ...msg,
        content: `${originalContent ? `${originalContent}\n` : ''}[图片消息：超过 MMX_IMAGE_ANALYSIS_LIMIT=${limit}，本次未调用 mmx 识别]`,
        imageAnalysis: { success: false, skipped: true, reason: 'limit_exceeded' }
      });
      continue;
    }

    analyzedCount += 1;
    try {
      const imageAnalysis = await analyzeImageMessageWithRetry(msg);
      enriched.push({
        ...msg,
        content: `${originalContent ? `${originalContent}\n` : ''}[图片识别 via mmx] ${imageAnalysis.description}`,
        imageAnalysis
      });
      console.log(`✅ 图片识别完成: ${getMessageMediaId(msg) || getImageCacheKey(msg)}`);
    } catch (error) {
      const safeError = String(error.stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 500);
      console.error(`⏭️ 图片识别最终失败，跳过该图片并继续后续消息: ${getMessageMediaId(msg) || getImageCacheKey(msg)} - ${safeError}`);
      enriched.push({
        ...msg,
        content: `${originalContent ? `${originalContent}\n` : ''}[图片消息：mmx 识别失败，错误：${safeError}]`,
        imageAnalysis: { success: false, error: safeError }
      });
    }
  }

  return enriched;
}

// 通用AI调用函数（返回内容与元信息）
async function callAIWithMeta(prompt, systemPrompt, retryCount = 0, forcedProvider = null) {
  const maxRetries = AI_CALL_MAX_RETRIES;
  const baseDelay = AI_RETRY_BASE_DELAY_MS;
  
  try {
    console.log(`🤖 AI调用 (第${retryCount + 1}次尝试)`);
    console.log('发送到AI的提示词长度:', prompt.length);
    
    // 不进行数据删减，保持完整性
    console.log('📊 提示词长度:', prompt.length, '字符');
    
    // 读取模型设置
    const modelConfig = await getModelConfig(forcedProvider);
    const provider = modelConfig.provider;
    // 兼容旧调用方:把 model / apiKey 摊平成 config 形状
    // apiKey 仍从 process.env 读(getModelConfig 内部已读过一次,这里再读以保留)
    const config = {
      model: modelConfig.model,
      apiKey: getEnvApiKey(getProviderKey(provider))
    };
    if (!config.apiKey) {
      throw new Error(`${provider} 的 API Key 未设置(请在 .env 中配置 ${getProviderKey(provider).toUpperCase()}_API_KEY)`);
    }

    let response;
    let timeoutDuration = AI_CALL_TIMEOUT_MS;

    // 根据提示词长度动态调整超时时间
    if (prompt.length > AI_CALL_LARGE_PROMPT_THRESHOLD) {
      timeoutDuration = AI_CALL_LARGE_TIMEOUT_MS;
      console.log(`📏 检测到大数据量，超时时间调整为${Math.round(timeoutDuration / 60000)}分钟`);
    }

    if (provider === 'DeepSeek') {
      response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: config.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 1.0,
        max_tokens: 64000,
        stream: false
      }, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutDuration,
        // 添加连接配置优化
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          maxSockets: 1,
          timeout: timeoutDuration
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          maxSockets: 1,
          timeout: timeoutDuration
        })
      });
      
      return {
        content: response.data.choices[0].message.content,
        meta: {
          provider,
          model: config.model,
          usage: response.data.usage || null
        }
      };
      
    } else if (provider === 'Gemini') {
      // Gemini特殊处理：分段发送大数据
      let finalPrompt = `${systemPrompt}\n\n${prompt}`;
      
      // 保持数据完整性，不进行分段处理
      console.log('📊 Gemini处理完整数据，长度:', finalPrompt.length, '字符');
      
      response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`, {
        contents: [{
          parts: [{
            text: finalPrompt
          }]
        }],
        generationConfig: {
          temperature: 1.0,
          maxOutputTokens: 32768
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_NONE"
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH", 
            threshold: "BLOCK_NONE"
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_NONE"
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_NONE"
          }
        ]
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: timeoutDuration,
        // 添加连接配置优化
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          maxSockets: 1,
          timeout: timeoutDuration
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          maxSockets: 1,
          timeout: timeoutDuration
        })
      });
      
      return {
        content: response.data.candidates[0].content.parts[0].text,
        meta: {
          provider,
          model: config.model,
          usage: response.data.usageMetadata || null
        }
      };
    } else if (provider === 'MiniMax') {
      response = await axios.post(`${MINIMAX_API_BASE}/chat/completions`, {
        model: config.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 32768,
        stream: false
      }, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutDuration,
        httpAgent: new (require('http').Agent)({
          keepAlive: true,
          maxSockets: 1,
          timeout: timeoutDuration
        }),
        httpsAgent: new (require('https').Agent)({
          keepAlive: true,
          maxSockets: 1,
          timeout: timeoutDuration
        })
      });

      return {
        content: response.data.choices[0].message.content,
        meta: {
          provider,
          model: config.model,
          usage: response.data.usage || null
        }
      };
    }
    
    throw new Error('不支持的AI提供商');
    
  } catch (error) {
    console.error(`❌ AI API调用失败 (第${retryCount + 1}次):`, error.message);
    
    // 判断是否需要重试
    const retryableErrorCodes = new Set([
      'ECONNABORTED',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN'
    ]);
    const errorMessage = error.message || '';
    const shouldRetry = retryCount < maxRetries && (
      retryableErrorCodes.has(error.code) ||
      errorMessage.includes('socket hang up') ||
      errorMessage.includes('Client network socket disconnected') ||
      errorMessage.includes('ECONNRESET') ||
      errorMessage.includes('ETIMEDOUT') ||
      (error.response?.status >= 500 && error.response?.status < 600) ||
      error.response?.status === 429
    );
    
    if (shouldRetry) {
      const delay = Math.min(AI_RETRY_MAX_DELAY_MS, baseDelay * Math.pow(2, retryCount)); // 指数退避
      console.log(`⏳ ${delay/1000}秒后进行第${retryCount + 2}次重试...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return await callAIWithMeta(prompt, systemPrompt, retryCount + 1, forcedProvider);
    }
    
    // 记录详细错误信息
    if (error.response) {
      console.error('API错误响应:', error.response.status, error.response.data);
    }
    
    throw error;
  }
}

// 通用AI调用函数（保持原有返回字符串行为）
async function callAI(prompt, systemPrompt) {
  const result = await callAIWithMeta(prompt, systemPrompt);
  return result.content;
}

// 数据完整性优先：不进行任何内容删减或采样
// 所有聊天数据将完整保留，确保分析结果的准确性

// 向后兼容的DeepSeek API调用函数
async function callDeepSeekAPI(prompt, systemPrompt) {
  return await callAI(prompt, systemPrompt);
}

// AI模型负载检测和推荐
async function checkAIModelHealth() {
  const results = {
    deepseek: { available: false, responseTime: null, error: null },
    gemini: { available: false, responseTime: null, error: null }
  };
  
  // 测试DeepSeek
  try {
    const startTime = Date.now();
    await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 1
    }, {
      headers: {
        'Authorization': `Bearer ${getEnvApiKey('deepseek')}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    results.deepseek.available = true;
    results.deepseek.responseTime = Date.now() - startTime;
  } catch (error) {
    results.deepseek.error = error.message;
  }
  
  // 测试Gemini
  try {
    const startTime = Date.now();
    await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${getEnvApiKey('gemini')}`, {
      contents: [{ parts: [{ text: 'test' }] }],
      generationConfig: { maxOutputTokens: 1 }
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    results.gemini.available = true;
    results.gemini.responseTime = Date.now() - startTime;
  } catch (error) {
    results.gemini.error = error.message;
  }
  
  return results;
}

// AI模型推荐接口
app.get('/api/ai-model-recommendation', async (req, res) => {
  try {
    const health = await checkAIModelHealth();
    
    let recommendation = {
      recommended: 'deepseek', // 默认推荐
      reason: '默认推荐',
      details: health
    };
    
    // 基于响应时间和可用性推荐
    if (health.deepseek.available && health.gemini.available) {
      if (health.deepseek.responseTime < health.gemini.responseTime) {
        recommendation.recommended = 'deepseek';
        recommendation.reason = `DeepSeek响应更快 (${health.deepseek.responseTime}ms vs ${health.gemini.responseTime}ms)`;
      } else {
        recommendation.recommended = 'gemini';
        recommendation.reason = `Gemini响应更快 (${health.gemini.responseTime}ms vs ${health.deepseek.responseTime}ms)`;
      }
    } else if (health.deepseek.available) {
      recommendation.recommended = 'deepseek';
      recommendation.reason = 'Gemini当前不可用';
    } else if (health.gemini.available) {
      recommendation.recommended = 'gemini';
      recommendation.reason = 'DeepSeek当前不可用';
    } else {
      recommendation.recommended = null;
      recommendation.reason = '所有AI模型当前都不可用';
    }
    
    res.json({ success: true, recommendation });
  } catch (error) {
    console.error('AI模型健康检查失败:', error);
    res.json({ 
      success: false, 
      error: '无法检查AI模型状态',
      recommendation: { recommended: 'deepseek', reason: '默认推荐' }
    });
  }
});

// 获取当前模型配置
// 单一事实源:
//   - model / modelProvider 从 model-settings.json 读(用户上次选择的)
//   - apiKey 永远从 process.env 经 getEnvApiKey(providerKey) 读
//   - 不从 model-settings.json 读 apiKey 字段(已废弃,会忽略)
// 返回 { provider, model, hasApiKey }。不再暴露 config.apiKey 给调用者。
async function getModelConfig(providerOverride = null) {
  try {
    const modelSettingsPath = path.join(__dirname, 'model-settings.json');
    const defaultSettings = getDefaultModelSettings();

    let settings = defaultSettings;
    if (fs.existsSync(modelSettingsPath)) {
      try {
        const rawSettings = JSON.parse(fs.readFileSync(modelSettingsPath, 'utf8'));
        settings = normalizeModelSettings(rawSettings);
      } catch (parseErr) {
        console.warn('model-settings.json 解析失败,使用默认:', parseErr.message);
        settings = defaultSettings;
      }
    }

    const provider = providerOverride || settings.modelProvider;
    const providerKey = getProviderKey(provider);
    if (!providerKey) {
      throw new Error(`不支持的模型提供商: ${provider}`);
    }

    // 从 model-settings.json 拿 model(用户上次选的)
    const storedConfig = settings[providerKey] || {};
    const model = storedConfig.model || defaultSettings[providerKey].model;

    // 从 process.env 拿 key(单一事实源)
    const apiKey = getEnvApiKey(providerKey);
    const hasApiKey = apiKey.length > 0 && apiKey !== 'your-deepseek-api-key-here';

    return { provider, model, hasApiKey };
  } catch (error) {
    console.error('读取模型配置失败:', error);
    const defaultSettings = getDefaultModelSettings();
    const provider = providerOverride || defaultSettings.modelProvider;
    const providerKey = getProviderKey(provider);
    const safeKey = providerKey || 'deepseek';
    return {
      provider: defaultSettings.modelProvider,
      model: defaultSettings[safeKey].model,
      hasApiKey: getEnvApiKey(safeKey).length > 0
    };
  }
}

function generatePromptTemplate(analysisType, chatData, customPrompt = '') {
  // 不做任何限制，保留完整数据
  const validMessages = chatData.filter(msg => msg.content && msg.content.trim().length > 0);
  const userStats = {};
  
  // 统计用户发言次数
  validMessages.forEach(msg => {
    if (msg.senderName) {
      userStats[msg.senderName] = (userStats[msg.senderName] || 0) + 1;
    }
  });
  
  const basicInfo = `
聊天数据概况：
- 群聊名称: ${chatData[0]?.talkerName || '未知群聊'}
- 消息总数: ${chatData.length} (有效文本消息: ${validMessages.length})
- 时间范围: ${chatData[0]?.time} 到 ${chatData[chatData.length-1]?.time}
- 活跃用户数: ${Object.keys(userStats).length}
- 主要发言用户: ${Object.entries(userStats).sort((a,b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => `${name}(${count}条)`).join(', ')}

完整聊天数据：
${validMessages.map(msg => `${msg.time} [${msg.senderName}]: ${msg.content}`).join('\n')}
`;

  // 如果有自定义提示词，直接使用
  if (customPrompt && customPrompt.trim()) {
    return `${basicInfo}

${customPrompt}`;
  }

  // 如果没有自定义提示词，返回基础信息
  return `${basicInfo}

请基于以上聊天数据进行分析。`;
}

// AI分析接口（修改为返回historyId）
app.post('/api/ai-analysis', async (req, res) => {
  try {
    const { groupName, analysisType, customPrompt, timeRange } = req.body;
    
    console.log('AI分析请求:', { groupName, analysisType, customPrompt, timeRange });

    if (!groupName) {
      return res.status(400).json({ error: '请指定群聊名称' });
    }

    // 获取聊天数据
    const chatData = await getChatData(groupName, timeRange || '2024-01-01~2025-12-31');
    
    if (!chatData || chatData.length === 0) {
      // 探测该群活跃度，区分「群名无效」与「所选时段无消息」，给出可操作提示
      const activity = await probeGroupActivity(groupName);
      if (activity.hasAnyMessage === false) {
        return res.json({
          success: false,
          reason: 'group_not_found',
          error: `未找到群聊「${groupName}」的任何聊天记录。请确认群聊名称是否与微信群名完全一致。`
        });
      }
      if (activity.hasAnyMessage === true) {
        return res.json({
          success: false,
          reason: 'empty_in_range',
          latestDate: activity.latestDate,
          error: `群聊「${groupName}」在所选时间范围（${timeRange || '默认'}）内没有聊天记录。该群最近一条消息时间约为 ${activity.latestDate || '未知'}，请调整时间范围后重试。`,
          suggestions: ['把时间范围改为「最近一周」或「最近一月」', `或选择包含 ${activity.latestDate || '该群活跃日'} 的自定义范围`]
        });
      }
      // probe 也失败（未知态）：回退到原通用文案
      return res.json({
        success: false,
        reason: 'unknown',
        error: '未找到聊天数据，请检查时间范围和群聊名称是否正确'
      });
    }

    // 识别图片消息后再生成提示词，确保图片内容进入群聊分析上下文
    const enrichedChatData = await enrichChatDataWithImageDescriptions(chatData);
    const imageAnalysisCount = enrichedChatData.filter(msg => msg.imageAnalysis?.success).length;
    const prompt = generatePromptTemplate(analysisType, enrichedChatData, customPrompt);
    const systemPrompt = `你是一个专业的数据分析师和前端开发工程师。请根据提供的聊天数据，生成一个完整的、可直接运行的HTML页面。

要求：
1. HTML页面必须完整，包含DOCTYPE、html、head、body等标签
2. CSS样式直接写在<style>标签内
3. JavaScript代码直接写在<script>标签内
4. 使用CDN引入必要的图表库（如Chart.js、D3.js等）
5. 页面要美观、专业、响应式
6. 包含真实的数据分析和可视化
7. 不要使用任何外部文件引用
8. 使用暖色系设计风格

直接返回完整的HTML代码，不要有任何其他说明文字。`;

    // 调用AI分析
    const analysisResult = await callAI(prompt, systemPrompt);
    
    // 保存到历史记录
    const metadata = {
      groupName,
      analysisType,
      timeRange,
      messageCount: chatData.length,
      imageAnalysisCount,
      timestamp: new Date().toISOString(),
      title: `${groupName} - ${getAnalysisTitle(analysisType)}`
    };
    
    const historyId = saveAnalysisHistory(metadata, analysisResult);
    
    res.json({ 
      success: true, 
      historyId: historyId,
      title: metadata.title,
      metadata: metadata
    });

  } catch (error) {
    console.error('AI分析失败:', error.message);
    
    let errorMessage = 'AI分析失败: ' + error.message;
    let suggestions = [];
    
    if (error.code === 'ECONNABORTED') {
      errorMessage = '分析超时，数据量过大导致处理时间过长';
      suggestions = [
        '建议缩小时间范围',
        '尝试分批次分析',
        '或稍后重试'
      ];
    } else if (error.message.includes('socket hang up')) {
      errorMessage = 'AI服务连接中断，通常是由于服务器负载过高';
      suggestions = [
        '🔄 系统已自动重试3次，建议稍等1-2分钟后再试',
        '🔀 建议切换到DeepSeek模型（通常更稳定且支持更大数据量）',
        '⏰ 避开高峰时段（如晚上8-10点）进行分析',
        '📱 检查网络连接是否稳定',
        '🎯 DeepSeek模型对大数据量分析更加稳定可靠'
      ];
    } else if (error.response?.status === 429) {
      errorMessage = 'API调用频率过高，请稍后重试';
      suggestions = [
        '等待1-2分钟后重试',
        '避免连续快速请求'
      ];
    } else if (error.response?.status === 413) {
      errorMessage = '请求数据过大，超出API限制';
      suggestions = [
        '减少分析的时间范围',
        '选择消息较少的群聊进行测试'
      ];
    }
    
    res.json({ 
      success: false, 
      error: errorMessage,
      suggestions: suggestions,
      errorCode: error.code,
      httpStatus: error.response?.status
    });
  }
});

app.post('/api/coding-plan', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { task, context = '', constraints = '', outputLang = 'zh-CN' } = req.body || {};

    if (!task || !String(task).trim()) {
      return res.status(400).json({
        success: false,
        error: 'task 不能为空',
        errorCode: 'INVALID_TASK'
      });
    }

    const systemPrompt = `你是资深软件工程负责人。请输出一份可执行的 coding plan，必须严格包含以下结构：
1. 目标拆解
2. 约束与假设
3. 实施步骤（按顺序，可直接执行）
4. 测试与验收标准
5. 风险与缓解策略
6. 回滚方案

输出要求：
- 使用 Markdown
- 结论明确、步骤具体、避免空话
- 所有命令和路径保留原文
- 输出语言使用 ${outputLang}`;

    const userPrompt = [
      `任务：${String(task).trim()}`,
      context ? `上下文：${String(context).trim()}` : '',
      constraints ? `约束：${String(constraints).trim()}` : ''
    ].filter(Boolean).join('\n\n');

    const result = await callAIWithMeta(userPrompt, systemPrompt, 0, 'MiniMax');
    const latencyMs = Date.now() - startedAt;

    res.json({
      success: true,
      planMarkdown: result.content,
      meta: {
        provider: result.meta?.provider || 'MiniMax',
        model: result.meta?.model || MINIMAX_MODEL,
        latencyMs,
        usage: result.meta?.usage || null
      }
    });
  } catch (error) {
    console.error('coding-plan 生成失败:', error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message,
      errorCode: error.code || 'CODING_PLAN_ERROR',
      httpStatus: error.response?.status || 500
    });
  }
});

function getAnalysisTitle(analysisType) {
  const titles = {
    'programming': '编程技术分析',
    'science': '科学学习分析', 
    'reading': '阅读讨论分析',
    'custom': '自定义分析'
  };
  return titles[analysisType] || '聊天数据分析';
}

function normalizeAnalysisContent(rawContent) {
  let content = String(rawContent || '').trim();

  // 移除推理标签，避免影响展示
  content = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();

  // 提取 fenced html 代码块（允许前面有其他文本）
  const htmlFenceMatch = content.match(/```html\s*([\s\S]*?)```/i);
  if (htmlFenceMatch && htmlFenceMatch[1]) {
    const fencedHtml = htmlFenceMatch[1].trim();
    if (fencedHtml.toLowerCase().startsWith('<!doctype html') || fencedHtml.toLowerCase().startsWith('<html')) {
      return { content: fencedHtml, isFullHtml: true };
    }
  }

  // 兼容未标注语言但内容是完整 HTML 的代码块
  const genericFenceMatch = content.match(/```[\w-]*\s*([\s\S]*?)```/);
  if (genericFenceMatch && genericFenceMatch[1]) {
    const fenced = genericFenceMatch[1].trim();
    if (fenced.toLowerCase().startsWith('<!doctype html') || fenced.toLowerCase().startsWith('<html')) {
      return { content: fenced, isFullHtml: true };
    }
  }

  // 直接是完整 HTML
  if (content.toLowerCase().startsWith('<!doctype html') || content.toLowerCase().startsWith('<html')) {
    return { content, isFullHtml: true };
  }

  return { content, isFullHtml: false };
}

// 获取分析历史记录接口
app.get('/api/analysis-history', (req, res) => {
  try {
    const history = getAnalysisHistory();
    res.json({ success: true, history });
  } catch (error) {
    console.error('获取历史记录失败:', error);
    res.json({ success: false, error: '获取历史记录失败' });
  }
});

// 获取特定分析记录接口
app.get('/api/analysis-history/:id', (req, res) => {
  try {
    const { id } = req.params;
    const filepath = path.join(HISTORY_DIR, `${id}.json`);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: '分析记录不存在' });
    }
    
    const content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    res.json({ success: true, data: content });
  } catch (error) {
    console.error('获取分析记录失败:', error);
    res.status(500).json({ success: false, error: '获取分析记录失败' });
  }
});

// 删除分析记录接口
app.delete('/api/analysis-history/:id', (req, res) => {
  try {
    const { id } = req.params;
    const filepath = path.join(HISTORY_DIR, `${id}.json`);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: '分析记录不存在' });
    }
    
    // 删除文件
    fs.unlinkSync(filepath);
    console.log(`删除分析记录: ${id}`);
    
    res.json({ success: true, message: '分析记录已删除' });
  } catch (error) {
    console.error('删除分析记录失败:', error);
    res.status(500).json({ success: false, error: '删除分析记录失败' });
  }
});

// 获取分析记录的原始聊天数据（用于导出聊天记录）
app.get('/api/analysis-chatlog/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const filepath = path.join(HISTORY_DIR, `${id}.json`);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: '分析记录不存在' });
    }
    
    const record = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    
    // 从记录中获取群组名称和时间范围，重新查询聊天数据
    const groupName = record.groupName || record.metadata?.groupName;
    const timeRange = record.timeRange || record.metadata?.timeRange;
    
    if (!groupName) {
      return res.status(400).json({ success: false, error: '分析记录中缺少群组信息' });
    }
    
    try {
      // 重新获取聊天数据
      const chatData = await getChatData(groupName, timeRange);
      res.json({ success: true, data: chatData });
    } catch (error) {
      console.error('获取聊天数据失败:', error);
      res.status(500).json({ success: false, error: '获取聊天数据失败: ' + error.message });
    }
    
  } catch (error) {
    console.error('获取分析聊天记录失败:', error);
    res.status(500).json({ success: false, error: '获取分析聊天记录失败' });
  }
});

// 获取分析记录的HTML内容（用于导出分析报告）
app.get('/api/analysis-content/:id', (req, res) => {
  try {
    const { id } = req.params;
    const filepath = path.join(HISTORY_DIR, `${id}.json`);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: '分析记录不存在' });
    }
    
    const record = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const normalized = normalizeAnalysisContent(record.content || '');
    let content = normalized.content;
    
    // 如果内容不是完整的HTML页面，需要包装
    if (!normalized.isFullHtml) {
      
      // 简单的Markdown到HTML转换（复用现有逻辑）
      let htmlContent = content
        .replace(/\n/g, '<br>')
        .replace(/#{6}\s*(.*?)(<br>|$)/g, '<h6>$1</h6>')
        .replace(/#{5}\s*(.*?)(<br>|$)/g, '<h5>$1</h5>')
        .replace(/#{4}\s*(.*?)(<br>|$)/g, '<h4>$1</h4>')
        .replace(/#{3}\s*(.*?)(<br>|$)/g, '<h3>$1</h3>')
        .replace(/#{2}\s*(.*?)(<br>|$)/g, '<h2>$1</h2>')
        .replace(/#{1}\s*(.*?)(<br>|$)/g, '<h1>$1</h1>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>');
      
      // 包装为完整的HTML页面
      content = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>${record.title || 'AI分析结果'}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 1200px;
              margin: 0 auto;
              padding: 20px;
              background-color: #f8f9fa;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
            h2 { color: #34495e; border-bottom: 2px solid #ecf0f1; padding-bottom: 8px; margin-top: 30px; }
            h3 { color: #7f8c8d; margin-top: 25px; }
            h4, h5, h6 { color: #95a5a6; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            ${htmlContent}
          </div>
        </body>
        </html>
      `;
    }
    
    res.json({ success: true, content: content });
    
  } catch (error) {
    console.error('获取分析内容失败:', error);
    res.status(500).json({ success: false, error: '获取分析内容失败' });
  }
});

// 新页面展示分析结果
app.get('/analysis/:id', (req, res) => {
  try {
    const { id } = req.params;
    const filepath = path.join(HISTORY_DIR, `${id}.json`);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>分析记录不存在</title>
          <meta charset="utf-8">
        </head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>❌ 分析记录不存在</h1>
          <p>请检查链接是否正确</p>
          <button onclick="window.close()">关闭窗口</button>
        </body>
        </html>
      `);
    }
    
    const record = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    
    const normalized = normalizeAnalysisContent(record.content || '');
    let content = normalized.content;

    // 检查内容是否已经是完整的HTML页面
    if (normalized.isFullHtml) {
      // 如果是完整的HTML页面，直接返回
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(content);
    }
    
    // 否则，将Markdown内容转换为HTML并包装在完整的HTML页面中
    const markdownContent = content;
    
    // 简单的Markdown到HTML转换
    let htmlContent = markdownContent
      .replace(/\n/g, '<br>')
      .replace(/#{6}\s*(.*?)(<br>|$)/g, '<h6>$1</h6>')
      .replace(/#{5}\s*(.*?)(<br>|$)/g, '<h5>$1</h5>')
      .replace(/#{4}\s*(.*?)(<br>|$)/g, '<h4>$1</h4>')
      .replace(/#{3}\s*(.*?)(<br>|$)/g, '<h3>$1</h3>')
      .replace(/#{2}\s*(.*?)(<br>|$)/g, '<h2>$1</h2>')
      .replace(/#{1}\s*(.*?)(<br>|$)/g, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/>\s*(.*?)(<br>|$)/g, '<blockquote>$1</blockquote>')
      .replace(/\|(.+?)\|/g, (match, content) => {
        const cells = content.split('|').map(cell => `<td>${cell.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      });
    
    // 包装表格
    htmlContent = htmlContent.replace(/(<tr>.*?<\/tr>)+/g, '<table border="1" style="border-collapse: collapse; width: 100%; margin: 10px 0;">$&</table>');
    
    // 处理列表项
    htmlContent = htmlContent.replace(/^-\s+(.*?)(<br>|$)/gm, '<li>$1</li>');
    htmlContent = htmlContent.replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>');
    
    // 处理数字列表
    htmlContent = htmlContent.replace(/^\d+\.\s+(.*?)(<br>|$)/gm, '<li>$1</li>');
    htmlContent = htmlContent.replace(/(<li>.*?<\/li>)+/g, '<ol>$&</ol>');
    
    const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${record.title || 'AI分析结果'}</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f8f9fa;
          }
          .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
          h2 { color: #34495e; border-bottom: 2px solid #ecf0f1; padding-bottom: 8px; margin-top: 30px; }
          h3 { color: #7f8c8d; margin-top: 25px; }
          h4, h5, h6 { color: #95a5a6; margin-top: 20px; }
          table { 
            border-collapse: collapse; 
            width: 100%; 
            margin: 15px 0; 
            background: white;
          }
          th, td { 
            border: 1px solid #ddd; 
            padding: 12px; 
            text-align: left; 
          }
          th { 
            background-color: #f8f9fa; 
            font-weight: bold;
            color: #2c3e50;
          }
          blockquote {
            border-left: 4px solid #3498db;
            margin: 15px 0;
            padding: 10px 20px;
            background-color: #f8f9fa;
            font-style: italic;
          }
          code {
            background-color: #f1f2f6;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.9em;
          }
          ul, ol {
            margin: 15px 0;
            padding-left: 30px;
          }
          li {
            margin: 8px 0;
          }
          .header-info {
            background: #ecf0f1;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
            font-size: 0.9em;
            color: #7f8c8d;
          }
          .close-btn {
            position: fixed;
            top: 20px;
            right: 20px;
            background: #e74c3c;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            z-index: 1000;
          }
          .close-btn:hover {
            background: #c0392b;
          }
          @media print {
            .close-btn { display: none; }
            body { background: white; }
            .container { box-shadow: none; }
          }
        </style>
      </head>
      <body>
        <button class="close-btn" onclick="window.close()">✕ 关闭</button>
        <div class="container">
          <div class="header-info">
            <strong>分析标题:</strong> ${record.title || '未知'}<br>
            <strong>群聊名称:</strong> ${record.groupName || '未知'}<br>
            <strong>时间范围:</strong> ${record.timeRange || '未知'}<br>
            <strong>消息数量:</strong> ${record.messageCount || 0}条<br>
            <strong>生成时间:</strong> ${record.savedAt ? new Date(record.savedAt).toLocaleString('zh-CN') : '未知'}
          </div>
          <div class="content">
            ${htmlContent}
          </div>
        </div>
      </body>
      </html>
    `;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fullHtml);
  } catch (error) {
    console.error('展示分析结果失败:', error);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>展示失败</title>
        <meta charset="utf-8">
      </head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>❌ 展示分析结果失败</h1>
        <p>${error.message}</p>
        <button onclick="window.close()">关闭窗口</button>
      </body>
      </html>
    `);
  }
});

// 测试DeepSeek API密钥的接口
app.get('/api/test-deepseek', async (req, res) => {
  try {
    console.log('测试DeepSeek API密钥...');
    console.log('API密钥前8位:', DEEPSEEK_API_KEY.substring(0, 8) + '****');
    
    const response = await axios.post(`${DEEPSEEK_API_BASE}/chat/completions`, {
      model: 'deepseek-reasoner',
      messages: [
        {
          role: 'user',
          content: '你好，请回复"连接成功"'
        }
      ],
      max_tokens: 50
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    res.json({ 
      success: true, 
      message: 'DeepSeek API连接成功',
      response: response.data.choices[0].message.content
    });
  } catch (error) {
    console.error('DeepSeek API测试失败:', error.message);
    if (error.response) {
      console.error('API错误响应:', error.response.status, error.response.data);
    }
    res.status(500).json({ 
      success: false,
      error: error.message,
      apiKey: DEEPSEEK_API_KEY ? `${DEEPSEEK_API_KEY.substring(0, 8)}****` : '未设置',
      details: error.response?.data || '无详细信息'
    });
  }
});

// 调试信息接口
app.get('/api/debug-env', (req, res) => {
  // 列出所有"非敏感"环境变量 + 已知的 AI key 是否设置(只返前缀不返真值)
  const knownAiKeys = ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'MINIMAX_API_KEY'];
  const aiKeyInfo = {};
  for (const k of knownAiKeys) {
    const v = process.env[k] || '';
    aiKeyInfo[k] = v ? { set: true, length: v.length, prefix: v.substring(0, 4) + '****' } : { set: false };
  }
  // 过滤出所有 *_API_KEY / *_MODEL / *_PROVIDER 之类的相关 key
  const allEnvKeys = Object.keys(process.env).filter(k =>
    k.endsWith('_API_KEY') || k.endsWith('_MODEL') || k.endsWith('_PROVIDER') || k.startsWith('MODEL_') ||
    k.startsWith('ENABLE_') || k.startsWith('SCHEDULED_') || k.startsWith('ANALYSIS_')
  );
  res.json({
    nodeEnv: process.env.NODE_ENV,
    aiKeyInfo,
    allEnvKeys
  });
});

// 检查Chatlog服务状态
app.get('/api/status', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // 增加超时时间和重试机制
    const maxRetries = 2;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔍 Chatlog连接检测第${attempt}次尝试...`);

        // 用 ping 判断 Chatlog HTTP 服务是否在线，不用 sessions。
        // sessions 依赖微信会话库解密，可能因 all_keys/data_key 问题返回 500；
        // 这类问题属于数据源异常，不应被误判为 HTTP 服务未连接。
        const response = await axios.get(`${CHATLOG_API_BASE}/ping`, {
          timeout: 15000, // 增加到15秒超时
          headers: {
            'User-Agent': 'chatlog-web/2.6.0',
            'Accept': 'application/json, text/plain, */*',
            'Connection': 'keep-alive'
          },
          // 添加重试配置
          validateStatus: function (status) {
            return status >= 200 && status < 500; // 不要对4xx状态码抛出错误
          }
        });
        
        if (response.status === 200) {
          console.log(`✅ Chatlog连接测试成功，状态码: ${response.status}`);
          return res.json({ 
            status: 'connected', 
            message: 'Chatlog HTTP服务连接正常',
            responseTime: Date.now() - startTime,
            attempt: attempt
          });
        } else {
          throw new Error(`HTTP ${response.status}: 服务响应异常`);
        }
        
  } catch (error) {
        lastError = error;
        console.log(`❌ Chatlog连接第${attempt}次尝试失败: ${error.message}`);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          console.log(`⏳ 等待2秒后进行第${attempt + 1}次重试...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    // 所有重试都失败了
    throw lastError;
    
  } catch (error) {
    console.error('Chatlog连接测试最终失败:', error.message);
    
    // 提供更详细的错误信息和解决建议
    let errorMessage = 'Chatlog服务未连接';
    let suggestions = [];
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Chatlog HTTP服务未启动';
      suggestions = [
        '请确保Chatlog应用正在运行',
        '检查端口5030是否被占用',
        '尝试重启Chatlog服务'
      ];
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      errorMessage = 'Chatlog服务响应超时';
      suggestions = [
        '服务可能正在启动中，请稍后重试',
        '检查系统资源是否充足',
        '确认Chatlog服务未出现异常'
      ];
    } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      errorMessage = 'Chatlog服务地址解析失败';
      suggestions = [
        '检查网络连接',
        '确认服务地址配置正确',
        '尝试使用IP地址代替域名'
      ];
    } else if (error.response?.status >= 400) {
      errorMessage = `Chatlog服务返回错误 (${error.response.status})`;
      suggestions = [
        '服务可能正在维护',
        '检查API接口是否正常',
        '查看Chatlog服务日志'
      ];
    } else {
      suggestions = [
        '检查Chatlog HTTP服务是否启动（端口5030）',
        '确认防火墙未阻止连接',
        '尝试重启相关服务'
      ];
    }
    
    res.status(503).json({ 
      status: 'disconnected', 
      message: errorMessage,
      details: error.message,
      suggestions: suggestions,
      errorCode: error.code,
      timestamp: new Date().toISOString()
    });
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: '服务器内部错误' });
});

// ============ 定时任务功能 ============

// 获取所有可用的分析项配置
async function getAllAnalysisItemsForSchedule() {
  try {
    // 这里需要读取AI设置配置，模拟前端的逻辑
    const analysisItems = [];
    
    // 默认分析项
    const defaultItems = [
      { id: 'programming', name: '编程群分析' },
      { id: 'science', name: '科学群分析' },
      { id: 'reading', name: '读者群分析' }
    ];
    
    // 从本地存储或配置文件读取设置（这里简化处理）
    // 实际应用中可以从数据库或配置文件读取
    const settingsFile = path.join(__dirname, 'ai-settings.json');
    let settings = {};
    
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      } catch (error) {
        console.log('读取AI设置文件失败，使用默认配置');
      }
    }
    
    // 检查每个默认分析项是否有配置
    defaultItems.forEach(item => {
      const itemSettings = settings[item.id];
      if (itemSettings && itemSettings.groupName) {
        analysisItems.push({
          id: item.id,
          name: itemSettings.displayName || item.name,
          groupName: itemSettings.groupName,
          analysisType: item.id,
          timeRange: itemSettings.timeRange || 'yesterday', // 尊重用户配置，缺省回退昨天
          customPrompt: itemSettings.prompt || ''
        });
      }
    });
    
    // 添加动态分析项
    if (settings.dynamicAnalysisItems) {
      // 兜底:用 array item.id(规范化后无 dynamic_ 前缀)直接找顶层配置,
      // 若没找到,再尝试 'dynamic_' + id 兼容旧磁盘
      const lookupTop = (id) => settings[id] || settings['dynamic_' + id] || null;
      settings.dynamicAnalysisItems.forEach(item => {
        const itemSettings = lookupTop(item.id);
        if (itemSettings && itemSettings.groupName) {
          analysisItems.push({
            id: 'dynamic_' + stripDynamicPrefix(item.id), // 出口处统一补回 dynamic_ 前缀
            name: itemSettings.displayName || item.displayName || item.id,
            groupName: itemSettings.groupName,
            analysisType: 'custom',
            timeRange: itemSettings.timeRange || 'yesterday',
            customPrompt: itemSettings.prompt || ''
          });
        }
      });
    }
    
    return analysisItems;
  } catch (error) {
    console.error('获取分析项配置失败:', error);
    return [];
  }
}

// 执行单个定时分析
async function executeScheduledAnalysis(analysisItem) {
  try {
    console.log(`🔄 开始执行定时分析: ${analysisItem.name}`);
    
    // 使用分析项配置的时间范围（缺省回退昨天）；normalizeChatlogTime 已能安全处理关键词与遗留非法值
    const timeRange = normalizeChatlogTime(analysisItem.timeRange || 'yesterday');

    // 获取聊天数据
    const chatData = await getChatData(analysisItem.groupName, timeRange);

    if (!chatData || chatData.length === 0) {
      console.log(`⚠️  ${analysisItem.name}: 所选时段(${timeRange})无聊天数据，跳过分析`);
      return { success: false, reason: '无聊天数据' };
    }
    
    // 识别图片消息后再生成提示词，保持定时分析与手动分析行为一致
    const enrichedChatData = await enrichChatDataWithImageDescriptions(chatData);
    const imageAnalysisCount = enrichedChatData.filter(msg => msg.imageAnalysis?.success).length;
    const prompt = generatePromptTemplate(analysisItem.analysisType, enrichedChatData, analysisItem.customPrompt);
    
    // 调用AI分析 - 使用与AI智能分析中心相同的SystemPrompt
    const systemPrompt = `你是一个专业的数据分析师和前端开发工程师。请根据提供的聊天数据，生成一个完整的、可直接运行的HTML页面。

要求：
1. HTML页面必须完整，包含DOCTYPE、html、head、body等标签
2. CSS样式直接写在<style>标签内
3. JavaScript代码直接写在<script>标签内
4. 使用CDN引入必要的图表库（如Chart.js、D3.js等）
5. 页面要美观、专业、响应式
6. 包含真实的数据分析和可视化
7. 不要使用任何外部文件引用
8. 使用暖色系设计风格

直接返回完整的HTML代码，不要有任何其他说明文字。`;
    
    const analysisResult = await callAI(prompt, systemPrompt);
    
    // 保存分析结果
    const title = `[定时] ${getAnalysisTitle(analysisItem.analysisType)} - ${analysisItem.name}`;
    const metadata = {
      title,
      groupName: analysisItem.groupName,
      analysisType: analysisItem.analysisType,
      timeRange,
      messageCount: chatData.length,
      imageAnalysisCount,
      isScheduled: true
    };
    
    const historyId = saveAnalysisHistory(metadata, analysisResult);
    
    console.log(`✅ ${analysisItem.name} 定时分析完成，ID: ${historyId}`);
    return { success: true, historyId, title };
    
  } catch (error) {
    console.error(`❌ ${analysisItem.name} 定时分析失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// 动态更新定时任务配置
function updateScheduledAnalysisConfig(newConfig) {
  try {
    // 更新全局配置变量
    ENABLE_SCHEDULED_ANALYSIS = newConfig.enabled;
    SCHEDULED_ANALYSIS_TIME = newConfig.cronTime;
    if (newConfig.analysisInterval !== undefined) {
      ANALYSIS_INTERVAL = normalizeAnalysisIntervalSeconds(newConfig.analysisInterval);
    }
    
    // 销毁现有的定时任务
    if (currentCronJob) {
      currentCronJob.stop();
      currentCronJob = null;
      console.log('🗑️  已停止现有定时任务');
    }
    
    // 如果启用了定时分析，创建新的定时任务
    if (ENABLE_SCHEDULED_ANALYSIS) {
      if (cron.validate(SCHEDULED_ANALYSIS_TIME)) {
        console.log(`⏰ 正在创建新的定时任务，执行时间: ${SCHEDULED_ANALYSIS_TIME}`);
        
        currentCronJob = cron.schedule(SCHEDULED_ANALYSIS_TIME, () => {
          console.log('\n⏰ 定时任务触发，开始执行批量分析...');
          runScheduledBatchAnalysis().catch(error => {
            console.error('定时分析执行失败:', error);
          });
        }, {
          timezone: "Asia/Shanghai",
          scheduled: false // 先不启动，后面手动启动
        });
        
        // 启动定时任务
        currentCronJob.start();
        console.log(`✅ 定时分析已启用，执行时间: ${SCHEDULED_ANALYSIS_TIME}`);
        console.log(`🌏 时区设置: Asia/Shanghai`);
        
        return { success: true, message: '定时任务配置已更新并生效' };
      } else {
        console.log(`❌ 定时任务配置错误: ${SCHEDULED_ANALYSIS_TIME}`);
        return { success: false, error: `Cron表达式无效: ${SCHEDULED_ANALYSIS_TIME}` };
      }
    } else {
      console.log(`⏸️  定时分析已禁用`);
      return { success: true, message: '定时分析已禁用' };
    }
    
  } catch (error) {
    console.error('更新定时任务配置失败:', error);
    return { success: false, error: error.message };
  }
}

// 执行批量定时分析
let isScheduledRunning = false; // 定时批量分析重入锁：cron 与手动触发共用，避免并发重复分析

async function runScheduledBatchAnalysis() {
  if (isScheduledRunning) {
    console.warn('⚠️ 定时批量分析已在运行中，本次触发被忽略（重入保护）');
    return { skipped: true, reason: 'already_running' };
  }
  isScheduledRunning = true;
  console.log('\n🕐 开始执行定时批量分析...');

  try {
    // 获取所有可用的分析项
    const analysisItems = await getAllAnalysisItemsForSchedule();
    
    if (analysisItems.length === 0) {
      console.log('⚠️  没有找到可用的分析项配置，跳过定时分析');
      return;
    }
    
    console.log(`📋 找到 ${analysisItems.length} 个分析项:`);
    analysisItems.forEach((item, index) => {
      console.log(`   ${index + 1}. ${item.name} (${item.groupName})`);
    });
    
    const results = {
      success: [],
      failed: [],
      skipped: []
    };
    
    // 逐个执行分析（避免API频率限制）
    for (let i = 0; i < analysisItems.length; i++) {
      const item = analysisItems[i];
      
      try {
        const result = await executeScheduledAnalysis(item);
        
        if (result.success) {
          results.success.push({ ...item, ...result });
        } else if (result.reason === '无聊天数据') {
          results.skipped.push({ ...item, reason: result.reason });
        } else {
          results.failed.push({ ...item, error: result.error });
        }
        
        // 分析间隔，避免API频率限制
        if (i < analysisItems.length - 1) {
          const intervalSeconds = normalizeAnalysisIntervalSeconds(ANALYSIS_INTERVAL);
          console.log(`⏳ 等待 ${intervalSeconds} 秒后继续下一个分析...`);
          await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
        }
        
      } catch (error) {
        console.error(`执行 ${item.name} 分析时发生异常:`, error);
        results.failed.push({ ...item, error: error.message });
      }
    }
    
    // 输出分析结果汇总
    console.log('\n📊 定时分析完成汇总:');
    console.log(`✅ 成功: ${results.success.length} 个`);
    console.log(`⚠️  跳过: ${results.skipped.length} 个`);
    console.log(`❌ 失败: ${results.failed.length} 个`);
    
    if (results.success.length > 0) {
      console.log('\n✅ 成功的分析:');
      results.success.forEach(item => {
        console.log(`   - ${item.title}`);
      });
    }
    
    if (results.skipped.length > 0) {
      console.log('\n⚠️  跳过的分析:');
      results.skipped.forEach(item => {
        console.log(`   - ${item.name}: ${item.reason}`);
      });
    }
    
    if (results.failed.length > 0) {
      console.log('\n❌ 失败的分析:');
      results.failed.forEach(item => {
        console.log(`   - ${item.name}: ${item.error}`);
      });
    }
    
    // R5：0 成功（全跳过/全失败）时发出醒目告警，提示数据源/服务异常，避免「以为正常」
    if (results.success.length === 0) {
      const ranges = [...new Set((analysisItems || []).map(i => i.timeRange))].join(', ');
      console.warn(`\n❌❌ 定时分析 0 成功：共 ${analysisItems.length} 项（跳过 ${results.skipped.length}、失败 ${results.failed.length}），时间范围「${ranges}」。疑似 Chatlog 无对应日期数据或服务异常，请检查数据源与 Chatlog 服务。`);
    }

    console.log('\n🎉 定时批量分析任务完成！\n');
    
  } catch (error) {
    console.error('❌ 定时批量分析执行失败:', error);
  } finally {
    isScheduledRunning = false;
  }
}

// 手动触发定时分析的API接口
app.post('/api/trigger-scheduled-analysis', async (req, res) => {
  try {
    if (isScheduledRunning) {
      return res.json({ success: false, message: '定时分析正在运行中，请稍后再试' });
    }
    console.log('🔄 手动触发定时分析...');

    // 异步执行，不阻塞响应
    runScheduledBatchAnalysis().catch(error => {
      console.error('手动触发的定时分析执行失败:', error);
    });
    
    res.json({ 
      success: true, 
      message: '定时分析已开始执行，请查看服务器日志获取进度' 
    });
  } catch (error) {
    console.error('触发定时分析失败:', error);
    res.status(500).json({ 
      success: false, 
      error: '触发定时分析失败: ' + error.message 
    });
  }
});

// 将Cron表达式转换为人类可读的时间格式
function cronToHumanReadable(cronExpression) {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 6) return cronExpression;
    
    const [sec, min, hour, day, month, week] = parts;
    
    // 格式化时间
    const formatTime = (h, m) => {
      const hourNum = parseInt(h);
      const minNum = parseInt(m);
      const period = hourNum >= 12 ? 'PM' : 'AM';
      const displayHour = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
      const displayMin = minNum.toString().padStart(2, '0');
      return `${period} ${displayHour}:${displayMin}`;
    };
    
    // 判断执行频率
    if (week === '*' && day === '*') {
      return `每天 ${formatTime(hour, min)}`;
    } else if (week === '1-5') {
      return `工作日 ${formatTime(hour, min)}`;
    } else if (week === '0,6') {
      return `周末 ${formatTime(hour, min)}`;
    } else if (/^\d$/.test(week)) {
      const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `${weekDays[parseInt(week)]} ${formatTime(hour, min)}`;
    } else if (hour.includes('/')) {
      const interval = hour.split('/')[1];
      return `每${interval}小时执行`;
    } else if (min.includes('/')) {
      const interval = min.split('/')[1];
      return `每${interval}分钟执行`;
    }
    
    return `${formatTime(hour, min)}`;
  } catch (error) {
    return cronExpression;
  }
}

// 获取定时任务状态的API接口
app.get('/api/scheduled-analysis-status', async (req, res) => {
  try {
    const analysisItems = await getAllAnalysisItemsForSchedule();
    
    res.json({
      success: true,
      enabled: ENABLE_SCHEDULED_ANALYSIS,
      cronTime: SCHEDULED_ANALYSIS_TIME,
      humanReadableTime: cronToHumanReadable(SCHEDULED_ANALYSIS_TIME),
      analysisInterval: ANALYSIS_INTERVAL,
      analysisIntervalMax: ANALYSIS_INTERVAL_MAX_SECONDS,
      nextRun: ENABLE_SCHEDULED_ANALYSIS ? cron.validate(SCHEDULED_ANALYSIS_TIME) ? '已配置' : '配置错误' : '未启用',
      analysisItems: analysisItems.map(item => ({
        name: item.name,
        groupName: item.groupName,
        analysisType: item.analysisType
      }))
    });
  } catch (error) {
    console.error('获取定时任务状态失败:', error);
    res.status(500).json({
      success: false,
      error: '获取定时任务状态失败: ' + error.message
    });
  }
});

// 默认 dynamic 项配置(用于"有按钮没配置"或"有配置没按钮"时的兜底)
function buildDefaultDynamicConfig(id) {
  return {
    id: id,
    displayName: id,
    timeRange: 'yesterday',
    groupName: '',
    prompt: '',
    customCron: '',
    analysisType: 'comprehensive',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function stripDynamicPrefix(id) {
  let value = String(id || '');
  while (value.startsWith('dynamic_')) {
    value = value.slice('dynamic_'.length);
  }
  return value;
}

// 规范化 analysisConfig:
//   - 保证 dynamicAnalysisItems 中每个项有对应顶层 dynamic_<canonicalId> 配置(反向合并)
//   - 保证顶层每个 dynamic_<canonicalId> 配置在数组里有对应项(正向合并)
//   - canonicalId:把 id 反复去 "dynamic_" 前缀直到不再以它开头(防止 dynamic_dynamic_xxx 翻倍)
//   - 过滤掉明显无效的项(缺 id 或 displayName)
function normalizeAnalysisConfig(config) {
  if (!config || typeof config !== 'object') {
    return { ok: false, error: 'analysisConfig 必须是对象' };
  }
  const out = { ...config };
  const items = Array.isArray(out.dynamicAnalysisItems) ? out.dynamicAnalysisItems : [];
  const validItems = [];
  const seenIds = new Set();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || !raw.id) continue;
    const canonicalId = stripDynamicPrefix(raw.id);
    if (!canonicalId || seenIds.has(canonicalId)) continue; // 去重
    seenIds.add(canonicalId);
    const displayName = raw.displayName || canonicalId;
    const item = { ...raw, id: canonicalId, displayName };
    validItems.push(item);
    // 数组项 -> 顶层配置(顶层 key 一律用 dynamic_<canonicalId>)
    const topKey = `dynamic_${canonicalId}`;
    if (!out[topKey] || typeof out[topKey] !== 'object') {
      out[topKey] = buildDefaultDynamicConfig(canonicalId);
    }
    // 合并:item 上的字段(除了 id/displayName)写入顶层配置
    out[topKey] = { ...out[topKey], ...item, id: canonicalId, displayName, updatedAt: new Date().toISOString() };
  }
  out.dynamicAnalysisItems = validItems;
  // 顶层 -> 数组项:把孤立的顶层 dynamic_<canonicalId> 补回数组
  for (const key of Object.keys(out)) {
    if (!key.startsWith('dynamic_')) continue;
    const canonicalId = stripDynamicPrefix(key);
    if (!canonicalId) continue;
    if (seenIds.has(canonicalId)) continue;
    const top = out[key];
    if (!top || typeof top !== 'object') continue;
    // 顶层 key 本身可能带 dynamic_ 前缀,统一成 dynamic_<canonicalId>
    if (key !== `dynamic_${canonicalId}`) {
      delete out[key];
    }
    validItems.push({
      id: canonicalId,
      displayName: top.displayName || canonicalId,
      timeRange: top.timeRange || 'yesterday',
      groupName: top.groupName || '',
      prompt: top.prompt || '',
      customCron: top.customCron || '',
      analysisType: top.analysisType || 'comprehensive',
      enabled: top.enabled !== false
    });
    seenIds.add(canonicalId);
  }
  return { ok: true, config: out };
}

// 原子写入:写到 .tmp 然后 rename
function atomicWriteJsonSync(filePath, data) {
  const fs = require('fs');
  const path = require('path');
  const tmpPath = filePath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  // fs.renameSync 在同分区下是原子的;若目标已存在,POSIX 行为是覆盖
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // 兜底:如果 rename 失败(目标被锁),尝试 unlink + rename
    try { fs.unlinkSync(filePath); } catch (_) {}
    fs.renameSync(tmpPath, filePath);
  }
}

// 保存分析项配置到服务器
// 合并写(不是整体覆盖):保留 ai-settings.json 里未在请求里出现的字段。
// 这样前端单独保存 dynamicAnalysisItems 不会清掉三个固定模板。
// 同时做配置规范化与原子写入。
app.post('/api/save-analysis-config', (req, res) => {
  try {
    const { analysisConfig } = req.body;

    if (!analysisConfig) {
      return res.status(400).json({
        success: false,
        error: '分析配置不能为空'
      });
    }

    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(__dirname, 'ai-settings.json');

    // 读旧配置(若存在),用 spread 合并
    let merged = {};
    if (fs.existsSync(settingsPath)) {
      try {
        merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (parseErr) {
        console.warn('ai-settings.json 解析失败,使用空对象:', parseErr.message);
        merged = {};
      }
    }

    // 合并:对每个顶级 key(includes.dynamicAnalysisItems / programming / science / reading 等)
    //   - dynamicAnalysisItems 用请求里的(整体替换)
    //   - 其它 key 把请求里的字段合并到旧值(不删旧字段)
    for (const key of Object.keys(analysisConfig)) {
      if (key === 'deletedDynamicIds') {
        continue;
      }
      if (key === 'dynamicAnalysisItems') {
        merged.dynamicAnalysisItems = analysisConfig.dynamicAnalysisItems;
      } else if (typeof analysisConfig[key] === 'object' && analysisConfig[key] !== null && typeof merged[key] === 'object' && merged[key] !== null) {
        merged[key] = { ...merged[key], ...analysisConfig[key] };
      } else {
        merged[key] = analysisConfig[key];
      }
    }

    if (Array.isArray(analysisConfig.deletedDynamicIds)) {
      analysisConfig.deletedDynamicIds.forEach(id => {
        const canonicalId = stripDynamicPrefix(id);
        if (canonicalId) {
          delete merged[canonicalId];
          delete merged[`dynamic_${canonicalId}`];
        }
      });
    }

    // 规范化:保证 dynamicAnalysisItems 与顶层 dynamic_<id> 双向一致
    const norm = normalizeAnalysisConfig(merged);
    if (!norm.ok) {
      return res.status(400).json({
        success: false,
        error: '配置规范化失败: ' + norm.error
      });
    }
    merged = norm.config;

    // 原子写入(避免写入中断造成 JSON 损坏)
    atomicWriteJsonSync(settingsPath, merged);

    console.log('✅ 分析项配置已规范化+原子保存到 ai-settings.json,dynamicAnalysisItems=' + (merged.dynamicAnalysisItems || []).length + ' 项');

    res.json({
      success: true,
      message: '分析项配置保存成功',
      itemCount: (merged.dynamicAnalysisItems || []).length
    });

  } catch (error) {
    console.error('保存分析项配置失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取分析项配置(返回前也做一次规范化,修复历史脏数据)
app.get('/api/get-analysis-config', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(__dirname, 'ai-settings.json');

    let settings = { dynamicAnalysisItems: [] };
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (parseErr) {
        console.warn('ai-settings.json 解析失败,使用默认空配置:', parseErr.message);
        settings = { dynamicAnalysisItems: [] };
      }
    }

    // 规范化(读路径也做一次,顺带修复脏数据)
    const norm = normalizeAnalysisConfig(settings);
    if (norm.ok) {
      settings = norm.config;
      // 如果规范化后产生了修复(例如补齐了缺失的顶层配置),
      // 不在此处写回,避免每次 GET 都触发 IO;由下次 save 时落盘。
    }

    res.json({
      success: true,
      config: settings
    });
  } catch (error) {
    console.error('获取分析项配置失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存定时任务配置
app.post('/api/save-scheduled-config', (req, res) => {
  try {
    const { enabled, cronTime, analysisTimeRange, analysisInterval, skipEmptyData, enableNotification, analysisItems } = req.body;
    const normalizedAnalysisInterval = normalizeAnalysisIntervalSeconds(analysisInterval);
    
    // 创建环境变量配置
    const envConfig = {
      ENABLE_SCHEDULED_ANALYSIS: enabled ? 'true' : 'false',
      SCHEDULED_ANALYSIS_TIME: cronTime || '0 8 * * *',
      ANALYSIS_TIME_RANGE: analysisTimeRange || 'yesterday',
      ANALYSIS_INTERVAL: normalizedAnalysisInterval,
      SKIP_EMPTY_DATA: skipEmptyData ? 'true' : 'false',
      ENABLE_NOTIFICATION: enableNotification ? 'true' : 'false'
    };
    
    // 读取现有的.env文件
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '.env');
    
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    // 更新环境变量
    Object.keys(envConfig).forEach(key => {
      const value = envConfig[key];
      const regex = new RegExp(`^${key}=.*$`, 'm');
      
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    });
    
    // 写入.env文件
    fs.writeFileSync(envPath, envContent.trim() + '\n');
    
    console.log('✅ 定时任务配置已保存到 .env 文件');
    
    // 动态更新定时任务配置，无需重启服务器
    const updateResult = updateScheduledAnalysisConfig({
      enabled: enabled,
      cronTime: cronTime || '0 0 8 * * *',
      analysisInterval: normalizedAnalysisInterval
    });
    
    if (updateResult.success) {
      res.json({
        success: true,
        message: '配置保存成功并已立即生效，无需重启服务器'
      });
    } else {
      res.json({
        success: false,
        error: `配置已保存到文件，但动态更新失败: ${updateResult.error}`
      });
    }
    
  } catch (error) {
    console.error('保存配置失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 测试Cron表达式
app.post('/api/test-cron-expression', (req, res) => {
  try {
    const { cronExpression } = req.body;
    
    if (!cronExpression) {
      return res.status(400).json({
        success: false,
        error: 'Cron表达式不能为空'
      });
    }
    
    // 验证Cron表达式格式
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 6) {
      return res.status(400).json({
        success: false,
        error: 'Cron表达式应包含6个部分'
      });
    }
    
    // 使用node-cron验证
    if (!cron.validate(cronExpression)) {
      return res.status(400).json({
        success: false,
        error: 'Cron表达式格式无效'
      });
    }
    
    // 计算下次执行时间（简单模拟）
    const now = new Date();
    const nextRun = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 简单示例：24小时后
    
    res.json({
      success: true,
      message: 'Cron表达式验证成功',
      nextRun: nextRun.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    });
    
  } catch (error) {
    console.error('测试Cron表达式失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 模型设置API端点

// 保存模型设置
// 只接 {modelProvider, deepseek: {model}, gemini: {model}, minimax: {model}}
// apiKey 永远从 .env 读(getEnvApiKey),不接、不存、不返。
app.post('/api/model-settings', (req, res) => {
  try {
    const { modelProvider, deepseek, gemini, minimax } = req.body;

    if (!modelProvider) {
      return res.status(400).json({
        success: false,
        error: '请选择模型提供商'
      });
    }

    const settingsData = normalizeModelSettings({
      modelProvider,
      deepseek:  deepseek  ? { model: deepseek.model }  : undefined,
      gemini:    gemini    ? { model: gemini.model }    : undefined,
      minimax:   minimax   ? { model: minimax.model }   : undefined
    });

    // 验证:选中的 provider 必须有 model,且 .env 里必须配了 key
    const selectedProviderKey = getProviderKey(settingsData.modelProvider);
    if (!selectedProviderKey) {
      return res.status(400).json({
        success: false,
        error: '不支持的模型提供商'
      });
    }
    const selectedModel = settingsData[selectedProviderKey] && settingsData[selectedProviderKey].model;
    if (!selectedModel) {
      return res.status(400).json({
        success: false,
        error: '请选择模型'
      });
    }
    if (!getEnvApiKey(selectedProviderKey)) {
      return res.status(400).json({
        success: false,
        error: `${settingsData.modelProvider} 的 API Key 未在 .env 中配置(请设 ${selectedProviderKey.toUpperCase()}_API_KEY 后重启服务)`
      });
    }

    // 写 .env:只更新非 key 字段(防止意外清掉 .env 里的 key)
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '.env');

    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const envUpdates = {
      'MODEL_PROVIDER':  settingsData.modelProvider,
      'DEEPSEEK_MODEL':  settingsData.deepseek.model,
      'GEMINI_MODEL':    settingsData.gemini.model,
      'MINIMAX_MODEL':   settingsData.minimax.model
    };

    Object.keys(envUpdates).forEach(key => {
      const value = envUpdates[key];
      const regex = new RegExp(`^${key}=.*$`, 'm');

      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    });

    fs.writeFileSync(envPath, envContent.trim() + '\n');

    // 写 model-settings.json:只持久化 provider + model,绝不写 apiKey
    const modelSettingsPath = path.join(__dirname, 'model-settings.json');
    const persistedSettings = {
      modelProvider: settingsData.modelProvider,
      deepseek: { model: settingsData.deepseek.model },
      gemini:   { model: settingsData.gemini.model },
      minimax:  { model: settingsData.minimax.model },
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(modelSettingsPath, JSON.stringify(persistedSettings, null, 2));

    console.log('✅ 模型设置已保存(key 不再持久化)');

    res.json({
      success: true,
      message: '模型设置保存成功(key 需重启服务生效)'
    });
    
  } catch (error) {
    console.error('保存模型设置失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取模型设置
// 不再返回 apiKey(mask 或原值),改为返回 hasApiKey: true/false。
// key 永远在 .env 里,前端不应该看到。
app.get('/api/model-settings', (req, res) => {
  try {
    const modelSettingsPath = path.join(__dirname, 'model-settings.json');

    let settings;
    if (fs.existsSync(modelSettingsPath)) {
      const rawSettings = JSON.parse(fs.readFileSync(modelSettingsPath, 'utf8'));
      settings = normalizeModelSettings(rawSettings);
    } else {
      settings = normalizeModelSettings();
    }

    const safeSettings = {
      modelProvider: settings.modelProvider,
      deepseek: { model: settings.deepseek.model, hasApiKey: getEnvApiKey('deepseek').length > 0 },
      gemini:   { model: settings.gemini.model,   hasApiKey: getEnvApiKey('gemini').length > 0 },
      minimax:  { model: settings.minimax.model,  hasApiKey: getEnvApiKey('minimax').length > 0 }
    };

    res.json({
      success: true,
      settings: safeSettings
    });
  } catch (error) {
    console.error('获取模型设置失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 测试模型连接
// 仅接 { provider, model },key 永远从 process.env 读(getEnvApiKey)。
// 前端 apiKey 输入框已 disabled,这里不再信任请求体里的 apiKey。
app.post('/api/model-settings/test', async (req, res) => {
  try {
    const { provider, model } = req.body;
    const providerKey = getProviderKey(provider);

    if (!provider) {
      return res.status(400).json({
        success: false,
        error: '请选择模型提供商'
      });
    }

    if (!providerKey) {
      return res.status(400).json({
        success: false,
        error: '不支持的模型提供商'
      });
    }

    if (!model) {
      return res.status(400).json({
        success: false,
        error: '请选择模型'
      });
    }

    const apiKey = getEnvApiKey(providerKey);
    if (!apiKey || apiKey === 'your-deepseek-api-key-here') {
      return res.status(400).json({
        success: false,
        error: `${provider} 的 API Key 未在 .env 中配置(请设 ${providerKey.toUpperCase()}_API_KEY 后重启服务)`
      });
    }

    let testResult;

    if (provider === 'DeepSeek') {
      testResult = await testDeepSeekConnection(apiKey, model);
    } else if (provider === 'Gemini') {
      testResult = await testGeminiConnection(apiKey, model);
    } else if (provider === 'MiniMax') {
      testResult = await testMiniMaxConnection(apiKey, model);
    } else {
      return res.status(400).json({
        success: false,
        error: '不支持的模型提供商'
      });
    }

    res.json(testResult);
    
  } catch (error) {
    console.error('测试模型连接失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DeepSeek连接测试函数
async function testDeepSeekConnection(apiKey, model) {
  try {
    const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: model,
      messages: [
        {
          role: 'user',
          content: '你好，请回复"连接测试成功"'
        }
      ],
      max_tokens: 50,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    if (response.status === 200 && response.data.choices && response.data.choices[0]) {
      return {
        success: true,
        message: '连接测试成功',
        model: model,
        response: response.data.choices[0].message.content
      };
    } else {
      return {
        success: false,
        error: '模型响应格式异常'
      };
    }
  } catch (error) {
    console.error('DeepSeek连接测试失败:', error.message);
    
    if (error.response) {
      const statusCode = error.response.status;
      const errorData = error.response.data;
      
      if (statusCode === 401) {
        return {
          success: false,
          error: 'API Key 无效，请检查您的密钥'
        };
      } else if (statusCode === 429) {
        return {
          success: false,
          error: 'API 调用频率超限，请稍后重试'
        };
      } else {
        return {
          success: false,
          error: `API 错误 (${statusCode}): ${errorData?.error?.message || '未知错误'}`
        };
      }
    } else {
      return {
        success: false,
        error: error.code === 'ECONNABORTED' ? '连接超时，请检查网络' : error.message
      };
    }
  }
}

// Gemini连接测试函数
async function testGeminiConnection(apiKey, model) {
  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      contents: [{
        parts: [{
          text: '你好，请回复"连接测试成功"'
        }]
      }]
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    if (response.status === 200 && response.data.candidates && response.data.candidates[0]) {
      return {
        success: true,
        message: '连接测试成功',
        model: model,
        response: response.data.candidates[0].content.parts[0].text
      };
    } else {
      return {
        success: false,
        error: '模型响应格式异常'
      };
    }
  } catch (error) {
    console.error('Gemini连接测试失败:', error.message);
    
    if (error.response) {
      const statusCode = error.response.status;
      const errorData = error.response.data;
      
      if (statusCode === 400) {
        return {
          success: false,
          error: 'API Key 无效或请求格式错误'
        };
      } else if (statusCode === 429) {
        return {
          success: false,
          error: 'API 调用频率超限，请稍后重试'
        };
      } else {
        return {
      success: false,
          error: `API 错误 (${statusCode}): ${errorData?.error?.message || '未知错误'}`
        };
  }
    } else {
      return {
        success: false,
        error: error.code === 'ECONNABORTED' ? '连接超时，请检查网络' : error.message
      };
    }
  }
}

// MiniMax连接测试函数（OpenAI兼容）
async function testMiniMaxConnection(apiKey, model) {
  let lastError = null;

  for (let attempt = 1; attempt <= MODEL_TEST_MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(`${MINIMAX_API_BASE}/chat/completions`, {
        model: model,
        messages: [
          {
            role: 'user',
            content: '请仅返回：连接测试成功'
          }
        ],
        max_tokens: 32,
        temperature: 0.1
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: MODEL_TEST_TIMEOUT_MS
      });

      if (response.status === 200 && response.data.choices && response.data.choices[0]) {
        return {
          success: true,
          message: '连接测试成功',
          model: model,
          response: response.data.choices[0].message.content
        };
      }

      return {
        success: false,
        error: '模型响应格式异常'
      };
    } catch (error) {
      lastError = error;
      const isTimeout = error.code === 'ECONNABORTED';
      const canRetry = isTimeout && attempt < MODEL_TEST_MAX_RETRIES;
      console.error(`MiniMax连接测试失败(第${attempt}次):`, error.message);

      if (!canRetry) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  if (lastError?.response) {
    const statusCode = lastError.response.status;
    const errorData = lastError.response.data;

    if (statusCode === 401 || statusCode === 403) {
      return {
        success: false,
        error: 'API Key 无效，请检查您的密钥'
      };
    } else if (statusCode === 429) {
      return {
        success: false,
        error: 'API 调用频率超限，请稍后重试'
      };
    }

    return {
      success: false,
      error: `API 错误 (${statusCode}): ${errorData?.error?.message || '未知错误'}`
    };
  }

  return {
    success: false,
    error: lastError?.code === 'ECONNABORTED' ? `连接超时，请检查网络（>${MODEL_TEST_TIMEOUT_MS / 1000}s）` : (lastError?.message || '未知错误')
  };
}

// 启动服务器
app.listen(PORT, () => {
  console.log(`\n🚀 聊天记录查询网站已启动`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  console.log(`🔗 请确保Chatlog HTTP服务已在端口5030启动`);
  
  // 初始化定时任务
  const initResult = updateScheduledAnalysisConfig({
    enabled: ENABLE_SCHEDULED_ANALYSIS,
    cronTime: SCHEDULED_ANALYSIS_TIME
  });
  
  if (!initResult.success && ENABLE_SCHEDULED_ANALYSIS) {
    console.log(`❌ 定时任务初始化失败: ${initResult.error}`);
  }
  
  console.log(`\n💡 手动触发定时分析: POST /api/trigger-scheduled-analysis`);
  console.log(`📊 查看定时任务状态: GET /api/scheduled-analysis-status\n`);
});
