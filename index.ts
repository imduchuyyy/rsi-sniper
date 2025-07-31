import axios from 'axios';
import WebSocket from 'ws';
import TelegramBot from 'node-telegram-bot-api';

// ====== CONFIG ======
const TELEGRAM_TOKEN = process.env.TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.CHAT_ID || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || TELEGRAM_CHAT_ID;
const volumeMultiplier = 2; // 2x average
const candleLimit = 30;
const delayMs = 1000;
const batchSize = 20;
const interval = '15m'; // M15
const numberCoins = 100;

// ====== SETUP ======
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const volumeHistory: Record<string, number[]> = {};
const alertQueue: { text: string }[] = [];

// ====== TYPES ======
interface KlineRest {
  0: number;
  5: string; // volume
  4: string; // close price
}

interface Ticker24h {
  symbol: string;
  quoteVolume: string;
}

interface KlineWs {
  x: boolean;
  v: string; // volume
  c: string; // close price
}

// ====== ALERT SYSTEM ======
setInterval(() => {
  const msg = alertQueue.shift();
  if (msg) {
    bot.sendMessage(TELEGRAM_CHAT_ID, msg.text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }).catch(console.error);
  }
}, 1100);

function sendVolumeAlert(symbol: string, volumeUSD: number, avgUSD: number) {
  const base = symbol.toUpperCase().replace('USDT', '');
  const msg = `📢 *#${base}* high volume spike: *$${(volumeUSD / 1_000).toFixed(4)}k*`;
  alertQueue.push({ text: msg });
  console.log(`📥 Queued volume alert: ${msg}`);
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

async function preloadVolumes(symbol: string): Promise<void> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${candleLimit}`;
    const res = await axios.get<KlineRest[]>(url);
    const volumes = res.data.map(k => parseFloat(k[5]) * parseFloat(k[4])); // volume * close = approx USD
    volumeHistory[symbol] = volumes;
    console.log(`✅ Preloaded volume for ${symbol.toUpperCase()}`);
  } catch {
    console.warn(`⚠️ Failed to preload ${symbol.toUpperCase()}`);
  }
}

async function preloadAll(symbols: string[]) {
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    await Promise.all(batch.map(preloadVolumes));
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

function buildCombinedStreamUrl(symbols: string[]) {
  const streams = symbols.map(s => `${s}@kline_${interval}`).join('/');
  return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

function startWebSocket(symbols: string[]) {
  const ws = new WebSocket(buildCombinedStreamUrl(symbols));

  ws.on('open', () => console.log('🔌 WebSocket connected'));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const symbol = msg.data.s.toLowerCase();
      const k: KlineWs = msg.data.k;

      if (!k.x) return;

      const close = parseFloat(k.c);
      const volume = parseFloat(k.v);
      const volumeUSD = volume * close;

      const history = volumeHistory[symbol] ||= [];
      const avg = history.reduce((a, b) => a + b, 0) / history.length;

      console.log(`📊 ${symbol.toUpperCase()} - Volume: $${(volumeUSD / 1_000).toFixed(2)}k, Avg: $${(avg / 1_000).toFixed(2)}k`);

      if (
        history.length >= candleLimit &&
        volumeUSD >= volumeMultiplier * avg &&
        volumeUSD >= 50_000 // must be at least $50k
      ) {
        sendVolumeAlert(symbol, volumeUSD, avg);
      }

      history.push(volumeUSD);
      if (history.length > candleLimit) history.shift();

    } catch (err) {
      console.error('❌ WS message error:', err);
    }
  });

  ws.on('error', err => console.error('❌ WebSocket error:', err));
}

// ====== MAIN ======
async function main() {
  try {
    const symbols = await getTopSymbols(numberCoins);
    await preloadAll(symbols);
    await bot.sendMessage(ADMIN_CHAT_ID, `🤖 Volume alert bot started for ${symbols.length} pairs.`);
    startWebSocket(symbols);
  } catch (err) {
    console.error('❌ Startup error:', err);
  }
}

main();
