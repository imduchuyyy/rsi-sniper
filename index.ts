import axios from 'axios';
import WebSocket from 'ws';
import { RSI } from 'technicalindicators';
import TelegramBot from 'node-telegram-bot-api';

// ====== CONFIG ======
const TELEGRAM_TOKEN = process.env.TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.CHAT_ID || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || TELEGRAM_CHAT_ID;
const rsiPeriod = 15;
const batchSize = 20;
const delayMs = 1000;
const rsiUpper = 80;
const rsiLower = 20;
const numberCoins = 100; // adjust here

// ====== SETUP ======
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const closePrices: Record<string, number[]> = {};
const lastAlert: Record<string, { type: 'high' | 'low' | null }> = {};
const alertQueue: { text: string }[] = [];

// Throttle Telegram messages to 1 per 1.1 seconds
setInterval(() => {
  const next = alertQueue.shift();
  if (next) {
    bot.sendMessage(TELEGRAM_CHAT_ID, next.text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }).catch(console.error);
  }
}, 1100);

// ====== TYPES ======
interface Ticker24h {
  symbol: string;
  quoteVolume: string;
}

interface KlineRest {
  0: number;
  4: string; // close price
}

interface KlineWs {
  t: number;
  c: string;
  x: boolean;
}

// ====== UTILS ======
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendRsiAlert(symbol: string, rsi: number, price?: number) {
  const status = rsi > rsiUpper ? '🔴' : '🟢';
  const alertType = rsi > rsiUpper ? 'high' : 'low';
  const base = symbol.toUpperCase().replace("USDT", "");
  const message = `${status} *#${base}* RSI ${alertType}: *${rsi.toFixed(2)}* at $${price?.toFixed(2)}`;
  alertQueue.push({ text: message });
  console.log(`📥 Queued alert: ${message}`);
}

// ====== CORE LOGIC ======

async function getTopSymbols(limit = 1000): Promise<string[]> {
  const stablecoins = ['USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'USTC', 'USDD'];
  const res = await axios.get<Ticker24h[]>('https://api.binance.com/api/v3/ticker/24hr');

  return res.data
    .filter(t => t.symbol.endsWith('USDT'))
    .filter(t => {
      const base = t.symbol.replace('USDT', '');
      return !stablecoins.includes(base);
    })
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map(t => t.symbol.toLowerCase());
}

async function preloadCloses(symbol: string): Promise<void> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=1m&limit=100`;
    const res = await axios.get<KlineRest[]>(url);
    closePrices[symbol] = res.data.map(k => parseFloat(k[4]));
    console.log(`✅ Preloaded ${symbol.toUpperCase()}`);
  } catch {
    console.warn(`⚠️ Failed to preload ${symbol.toUpperCase()}`);
  }
}

async function preloadAll(symbols: string[]) {
  console.log(`⏳ Preloading closes for ${symbols.length} symbols in batches...`);
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    await Promise.all(batch.map(preloadCloses));
    await sleep(delayMs);
  }
  console.log('✅ All preloading done.');
}

function buildCombinedStreamUrl(symbols: string[]) {
  const streams = symbols.map(s => `${s}@kline_1m`).join('/');
  return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

function startWebSocket(symbols: string[]) {
  const wsUrl = buildCombinedStreamUrl(symbols);
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('🔌 WebSocket connected to Binance');
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const symbol = msg.data.s.toLowerCase();
      const k: KlineWs = msg.data.k;
      if (!k.x) return;

      const close = parseFloat(k.c);
      const arr = closePrices[symbol] ||= [];
      arr.push(close);
      if (arr.length > 100) arr.shift();

      if (arr.length >= rsiPeriod) {
        const rsi = RSI.calculate({ values: arr, period: rsiPeriod });
        const latest = rsi.at(-1);
        if (latest !== undefined) {
          const alert = lastAlert[symbol] || { type: null };
          if (latest > rsiUpper && alert.type !== 'high') {
            sendRsiAlert(symbol, latest, close);
            lastAlert[symbol] = { type: 'high' };
          } else if (latest < rsiLower && alert.type !== 'low') {
            sendRsiAlert(symbol, latest, close);
            lastAlert[symbol] = { type: 'low' };
          } else if (latest >= rsiLower && latest <= rsiUpper) {
            lastAlert[symbol] = { type: null };
          }
        }
      }
    } catch (err) {
      console.error('❌ WebSocket message error:', err);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket connection error:', err);
  });
}

// ====== ENTRY POINT ======
async function main() {
  try {
    const symbols = await getTopSymbols(numberCoins);
    await preloadAll(symbols);
    await bot.sendMessage(ADMIN_CHAT_ID, `🤖 RSI bot started. Tracking ${symbols.length} coins.`);

    startWebSocket(symbols);
  } catch (err) {
    console.error('❌ Bot startup error:', err);
  }
}

main();
