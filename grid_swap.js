import "dotenv/config";
import bs58 from "bs58";
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import {
    Keypair,
    VersionedTransaction,
    LAMPORTS_PER_SOL,
    Connection,
    PublicKey,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";

/**
 * 公共RPC 429 修复版：Pyth触发 + Jupiter成交
 * 重点：极限减少 Solana RPC 调用
 *  - 余额缓存（TTL）
 *  - USDC缓冲检查节流（分钟级）
 *  - 交易确认指数退避（降低 getSignatureStatuses 压力）
 *  - RPC 429 自动退避重试（有限次数）
 */

// =======================
// 配置
// =======================
const RPC_URL = process.env.SOL_RPC_URL || "https://api.mainnet-beta.solana.com";

const USDC_MINT =
    process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT =
    process.env.SOL_MINT || "So11111111111111111111111111111111111111112";

const JUP_API_KEY = process.env.JUP_API_KEY || "";
const JUP_BASE = process.env.JUP_BASE || "https://api.jup.ag/ultra/v1";

const PYTH_HERMES_URL = process.env.PYTH_HERMES_URL || "https://hermes.pyth.network";
const PYTH_QUERY = process.env.PYTH_QUERY || "SOL/USD";
const PYTH_ASSET_TYPE = process.env.PYTH_ASSET_TYPE || "crypto";
const PYTH_PRICE_ID = (process.env.PYTH_PRICE_ID || "").trim();

const GRID_COUNT = parseInt(process.env.GRID_COUNT || "100", 10);
const GRID_RANGE_PERCENT = parseFloat(process.env.GRID_RANGE_PERCENT || "2");

const PRICE_CHECK_INTERVAL_MS = parseInt(process.env.PRICE_CHECK_INTERVAL_MS || "12000", 10);

const MIN_TRADE_SOL = parseFloat(process.env.MIN_TRADE_SOL || "0.0006");
const MAX_TRADE_SOL = parseFloat(process.env.MAX_TRADE_SOL || "0.0015");

const MAX_POS_PER_LEVEL = parseInt(process.env.MAX_POS_PER_LEVEL || "3", 10);
const MAX_TRADES_PER_TICK = parseInt(process.env.MAX_TRADES_PER_TICK || "2", 10);
const POST_TRADE_COOLDOWN_MS = parseInt(process.env.POST_TRADE_COOLDOWN_MS || "2000", 10);

const MIN_BALANCE_SOL = parseFloat(process.env.MIN_BALANCE_SOL || "0.02");

const TARGET_USDC_BUFFER = parseFloat(process.env.TARGET_USDC_BUFFER || "8");
const MIN_SOL_KEEP = parseFloat(process.env.MIN_SOL_KEEP || "0.10");

const REGRID_OUTSIDE_PCT = parseFloat(process.env.REGRID_OUTSIDE_PCT || "0.8");
const REGRID_COOLDOWN_MS = parseInt(process.env.REGRID_COOLDOWN_MS || "1800000", 10);

// ===== 429/RPC降压关键参数 =====
const BAL_CACHE_TTL_MS = parseInt(process.env.BAL_CACHE_TTL_MS || "60000", 10);
const ENSURE_USDC_INTERVAL_MS = parseInt(process.env.ENSURE_USDC_INTERVAL_MS || "180000", 10);

const CONFIRM_TIMEOUT_MS = parseInt(process.env.CONFIRM_TIMEOUT_MS || "90000", 10);
const CONFIRM_START_DELAY_MS = parseInt(process.env.CONFIRM_START_DELAY_MS || "2500", 10);
const CONFIRM_MAX_DELAY_MS = parseInt(process.env.CONFIRM_MAX_DELAY_MS || "12000", 10);
const CONFIRM_BACKOFF_MULT = parseFloat(process.env.CONFIRM_BACKOFF_MULT || "1.5");

const USDC_DECIMALS = 1_000_000;

if (!process.env.SOL_PRIVATE_KEYS) throw new Error("❌ .env 中 SOL_PRIVATE_KEYS 为空");
if (!JUP_API_KEY) throw new Error("❌ .env 中 JUP_API_KEY 为空");
if (GRID_RANGE_PERCENT <= 0) throw new Error("❌ GRID_RANGE_PERCENT 必须 > 0");
if (GRID_COUNT < 10) throw new Error("❌ GRID_COUNT 太小");
if (MIN_TRADE_SOL <= 0 || MAX_TRADE_SOL <= 0 || MIN_TRADE_SOL > MAX_TRADE_SOL) {
    throw new Error("❌ MIN_TRADE_SOL/MAX_TRADE_SOL 配置不合法");
}

// =======================
// 代理（可选）
// =======================
const rawProxies = process.env.SOL_PROXIES || "";
const proxyList = rawProxies.split(",").map((p) => p.trim()).filter(Boolean);

function buildProxyAgent(proxyStr) {
    const [host, port, user, pass] = proxyStr.split(":");
    return new SocksProxyAgent(`socks5h://${user}:${pass}@${host}:${port}`);
}

const proxyAgent = proxyList.length ? buildProxyAgent(proxyList[0]) : null;

// =======================
// 文件状态
// =======================
const STATE_DIR = path.resolve(process.cwd(), "state");
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

function statePath(pubkeyStr) {
    return path.join(STATE_DIR, `${pubkeyStr}.json`);
}
function loadState(pubkeyStr) {
    const p = statePath(pubkeyStr);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
}
function saveState(pubkeyStr, state) {
    fs.writeFileSync(statePath(pubkeyStr), JSON.stringify(state, null, 2));
}

// =======================
// 工具
// =======================
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function randFloat(min, max) {
    return min + Math.random() * (max - min);
}
function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
}
function todayStrLocal() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

// =======================
// 账户加载（单钱包）
// =======================
const keyList = process.env.SOL_PRIVATE_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
const kp = Keypair.fromSecretKey(bs58.decode(keyList[0]));

const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    fetchMiddleware: proxyAgent
        ? (info, init, fetch_) => fetch_(info, { ...init, agent: proxyAgent })
        : undefined,
});

const worker = {
    label: "W1",
    keypair: kp,
    connection,
    proxyAgent,
};

// =======================
// fetch with retry + timeout (HTTP: Pyth/Jupiter)
// =======================
async function fetchJsonWithRetry(url, options = {}, retries = 4, timeoutMs = 15000) {
    for (let i = 0; i < retries; i++) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(t);

            if (res.ok) return await res.json();

            if (res.status === 429) {
                const backoff = 800 + i * 1200;
                console.warn(`[Retry] 429 限频, ${backoff}ms 后重试...`);
                await sleep(backoff);
                continue;
            }

            const body = await res.text();
            throw new Error(`HTTP ${res.status}: ${body}`);
        } catch (e) {
            clearTimeout(t);
            if (i === retries - 1) throw e;
            const isTls = /TLS|socket disconnected|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(e.message);
            const backoff = isTls ? 2000 + i * 2000 : 800 + i * 800;
            console.warn(`[Retry] ${isTls ? "网络/TLS" : "请求"}异常 (${e.message.slice(0, 80)}), ${backoff}ms 后第 ${i + 1} 次重试...`);
            await sleep(backoff);
        }
    }
}

// =======================
// RPC 429 退避重试封装（公共RPC关键）
// =======================
function isRpc429(err) {
    const msg = String(err?.message || err || "");
    return msg.includes("429") || msg.includes("Too many requests");
}

async function rpcCallWithBackoff(fn, retries = 4) {
    let delay = 600;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            if (i === retries || !isRpc429(e)) throw e;
            await sleep(delay);
            delay = Math.min(6000, Math.floor(delay * 2));
        }
    }
}

// =======================
// 余额：SOL + USDC（带缓存）
// =======================
async function getBalanceSOL(w) {
    const lamports = await rpcCallWithBackoff(() => w.connection.getBalance(w.keypair.publicKey));
    return lamports / LAMPORTS_PER_SOL;
}

async function getTokenBalanceUI(w, mintStr) {
    const mint = new PublicKey(mintStr);
    const res = await rpcCallWithBackoff(() =>
        w.connection.getParsedTokenAccountsByOwner(w.keypair.publicKey, { mint })
    );
    if (!res.value || res.value.length === 0) return 0;

    let total = 0;
    for (const acc of res.value) {
        const ui = acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
        total += ui;
    }
    return total;
}

const balCache = {
    sol: { v: null, t: 0 },
    usdc: { v: null, t: 0 },
};

function invalidateBalanceCache() {
    balCache.sol.v = null;
    balCache.usdc.v = null;
}

async function getBalanceSOLCached(w, ttlMs = BAL_CACHE_TTL_MS) {
    const now = Date.now();
    if (balCache.sol.v != null && now - balCache.sol.t < ttlMs) return balCache.sol.v;
    const v = await getBalanceSOL(w);
    balCache.sol = { v, t: now };
    return v;
}

async function getUsdcBalanceCached(w, ttlMs = BAL_CACHE_TTL_MS) {
    const now = Date.now();
    if (balCache.usdc.v != null && now - balCache.usdc.t < ttlMs) return balCache.usdc.v;
    const v = await getTokenBalanceUI(w, USDC_MINT);
    balCache.usdc = { v, t: now };
    return v;
}

// =======================
// Jupiter Ultra API
// =======================
async function getOrder(w, inputMint, outputMint, amount) {
    const url =
        `${JUP_BASE}/order` +
        `?inputMint=${inputMint}` +
        `&outputMint=${outputMint}` +
        `&amount=${amount}` +
        `&taker=${w.keypair.publicKey.toString()}`;

    return await fetchJsonWithRetry(url, {
        headers: { "x-api-key": JUP_API_KEY },
        agent: w.proxyAgent || undefined,
    });
}

async function executeOrder(w, signedTransaction, requestId) {
    return await fetchJsonWithRetry(`${JUP_BASE}/execute`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": JUP_API_KEY,
        },
        body: JSON.stringify({ signedTransaction, requestId }),
        agent: w.proxyAgent || undefined,
    });
}

// =======================
// 交易确认：指数退避（减少 getSignatureStatuses）
// =======================
async function confirmSignature(w, signature, timeoutMs = CONFIRM_TIMEOUT_MS) {
    const start = Date.now();
    let delay = CONFIRM_START_DELAY_MS;

    while (Date.now() - start < timeoutMs) {
        const st = await rpcCallWithBackoff(() =>
            w.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
        );
        const s = st?.value?.[0];
        if (s) {
            if (s.err) throw new Error(`链上失败: ${JSON.stringify(s.err)}`);
            if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return true;
        }
        await sleep(delay);
        delay = Math.min(CONFIRM_MAX_DELAY_MS, Math.floor(delay * CONFIRM_BACKOFF_MULT));
    }
    throw new Error("确认超时：交易未在限定时间内 confirmed");
}

async function doSwap(w, inputMint, outputMint, amount, label) {
    const order = await getOrder(w, inputMint, outputMint, amount);
    if (!order || !order.transaction || !order.requestId) {
        console.error(`[${w.label}] ❌ ${label} 获取 Order 失败:`, JSON.stringify(order));
        return { ok: false };
    }

    const txBuf = Buffer.from(order.transaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([w.keypair]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    const res = await executeOrder(w, signedTx, order.requestId);
    if (!res || res.status !== "Success" || !res.signature) {
        console.error(`[${w.label}] ❌ ${label} 执行失败:`, JSON.stringify(res));
        return { ok: false };
    }

    console.log(`[${w.label}] ⛓️ 已提交: https://solscan.io/tx/${res.signature}`);
    await confirmSignature(w, res.signature);

    // 成交后刷新缓存，避免用旧余额继续决策
    invalidateBalanceCache();

    console.log(`[${w.label}] ✅ 已确认: ${label}`);
    return { ok: true, signature: res.signature };
}

// =======================
// Pyth Hermes：发现 priceId + 取最新价格
// =======================
function isDerivativeSol(symUpper, descUpper) {
    // 过滤 LST/衍生（避免 MSOL/USD）
    const bad = ["MSOL", "BSOL", "JITOSOL", "STSOL"];
    if (bad.some((t) => symUpper.includes(t))) return true;
    if (descUpper.includes("STAKED SOL")) return true;
    if (descUpper.includes("MARINADE STAKED SOL")) return true;
    return false;
}

async function resolvePythPriceIdStrict() {
    if (PYTH_PRICE_ID) {
        return {
            id: PYTH_PRICE_ID,
            meta: { attributes: { symbol: "ENV_OVERRIDE", description: "PYTH_PRICE_ID" } },
        };
    }

    const url =
        `${PYTH_HERMES_URL}/v2/price_feeds` +
        `?query=${encodeURIComponent(PYTH_QUERY)}` +
        `&asset_type=${encodeURIComponent(PYTH_ASSET_TYPE)}`;

    const feeds = await fetchJsonWithRetry(url, {}, 3, 15000);
    if (!Array.isArray(feeds) || feeds.length === 0) {
        throw new Error(`❌ Hermes 未找到 price feed: query=${PYTH_QUERY}, asset_type=${PYTH_ASSET_TYPE}`);
    }

    const byDesc = feeds.find((f) => {
        const sym = String(f?.attributes?.symbol || "").toUpperCase();
        const desc = String(f?.attributes?.description || "").toUpperCase();
        if (isDerivativeSol(sym, desc)) return false;
        return desc === "SOLANA / US DOLLAR" || desc.includes("SOLANA / US DOLLAR");
    });

    const bySym = feeds.find((f) => {
        const sym = String(f?.attributes?.symbol || "").toUpperCase();
        const desc = String(f?.attributes?.description || "").toUpperCase();
        if (isDerivativeSol(sym, desc)) return false;
        return sym === "CRYPTO.SOL/USD" || sym.endsWith(".SOL/USD");
    });

    const pick = byDesc || bySym || feeds.find((f) => {
        const sym = String(f?.attributes?.symbol || "").toUpperCase();
        const desc = String(f?.attributes?.description || "").toUpperCase();
        if (isDerivativeSol(sym, desc)) return false;
        return sym.includes("SOL/USD") || desc.includes("SOLANA");
    });

    if (!pick?.id) {
        console.log("Hermes candidates (first 30):");
        for (const f of feeds.slice(0, 30)) {
            console.log("-", f.id, f.attributes?.symbol, f.attributes?.description);
        }
        throw new Error("❌ 无法定位 SOL/USD feed（已打印候选）");
    }

    return { id: pick.id, meta: pick };
}

async function getPythPrice(priceId) {
    const url = new URL(`${PYTH_HERMES_URL}/v2/updates/price/latest`);
    url.searchParams.append("ids[]", priceId);

    const data = await fetchJsonWithRetry(url.toString(), {}, 3, 15000);
    const parsed = data?.parsed;
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`❌ Hermes 返回无 parsed 数据: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const p = parsed[0]?.price;
    const priceInt = Number(p?.price);
    const expo = Number(p?.expo);
    if (!Number.isFinite(priceInt) || !Number.isFinite(expo)) {
        throw new Error(`❌ Hermes price 格式异常: ${JSON.stringify(parsed[0]).slice(0, 300)}`);
    }

    const price = priceInt * Math.pow(10, expo);
    const publishTime = p?.publish_time ? Number(p.publish_time) : null;

    if (!Number.isFinite(price) || price <= 0) throw new Error("❌ Hermes 价格计算异常");
    return { price, publishTime };
}

// =======================
// 网格 + 状态
// =======================
function initGrid(basePrice) {
    const low = basePrice * (1 - GRID_RANGE_PERCENT / 100);
    const high = basePrice * (1 + GRID_RANGE_PERCENT / 100);
    const step = (high - low) / GRID_COUNT;

    const levels = [];
    for (let i = 0; i <= GRID_COUNT; i++) {
        levels.push({ index: i, price: parseFloat((low + step * i).toFixed(6)) });
    }

    return { basePrice, low, high, levels };
}

function makeEmptyState(grid, lastPrice) {
    return {
        grid,
        lastPrice,
        positions: [], // {id, entryIndex, targetIndex, amountSol, entryPrice, createdAt}
        nextPosId: 1,
        daily: { date: todayStrLocal(), trades: 0 },
        lastRegridAt: null,
        lastTopUpAt: null,
    };
}

function countPositionsAtLevel(state, entryIndex) {
    return state.positions.filter((p) => p.entryIndex === entryIndex).length;
}

function bumpDailyTrades(state, n = 1) {
    const today = todayStrLocal();
    if (state.daily?.date !== today) state.daily = { date: today, trades: 0 };
    state.daily.trades += n;
}

function shouldRegrid(state, price) {
    const { low, high } = state.grid;
    const upper = high * (1 + REGRID_OUTSIDE_PCT / 100);
    const lower = low * (1 - REGRID_OUTSIDE_PCT / 100);
    return price > upper || price < lower;
}

function canRegrid(state) {
    if (!state.lastRegridAt) return true;
    return Date.now() - state.lastRegridAt >= REGRID_COOLDOWN_MS;
}

function doRegrid(state, newBasePrice) {
    state.grid = initGrid(newBasePrice);
    state.lastRegridAt = Date.now();
    state.positions = [];      // 保守：清空旧仓位
    state.lastPrice = newBasePrice;
}

// =======================
// USDC 缓冲（节流 + 缓存）
// =======================
let lastEnsureUsdcAt = 0;

async function ensureUsdcBuffer(w, state, currentPrice) {
    const now = Date.now();
    if (now - lastEnsureUsdcAt < ENSURE_USDC_INTERVAL_MS) {
        return { ok: true, didTopUp: false, usdcBal: await getUsdcBalanceCached(w) };
    }
    lastEnsureUsdcAt = now;

    const usdcBal = await getUsdcBalanceCached(w);
    if (usdcBal >= TARGET_USDC_BUFFER) return { ok: true, didTopUp: false, usdcBal };

    const solBal = await getBalanceSOLCached(w);
    const sellableSol = solBal - MIN_SOL_KEEP - MIN_BALANCE_SOL;
    if (sellableSol <= 0) {
        console.warn(
            `[${w.label}] ⚠️ USDC不足(${usdcBal.toFixed(2)}/${TARGET_USDC_BUFFER}), 但SOL可卖不足(SOL=${solBal.toFixed(4)}).`
        );
        return { ok: false, didTopUp: false, usdcBal };
    }

    const needUsdc = TARGET_USDC_BUFFER - usdcBal;
    const solToSell = Math.min(sellableSol, (needUsdc / currentPrice) * 1.05);
    if (solToSell < 0.0005) return { ok: true, didTopUp: false, usdcBal };

    const lamports = Math.floor(solToSell * LAMPORTS_PER_SOL);

    console.log(
        `\n💱 USDC不足(${usdcBal.toFixed(2)}/${TARGET_USDC_BUFFER}), 卖出约 ${solToSell.toFixed(4)} SOL 建立缓冲`
    );

    const r = await doSwap(w, SOL_MINT, USDC_MINT, lamports, `补USDC缓冲(目标${TARGET_USDC_BUFFER})`);
    if (!r.ok) return { ok: false, didTopUp: false, usdcBal };

    state.lastTopUpAt = Date.now();
    saveState(w.keypair.publicKey.toBase58(), state);

    const usdcBal2 = await getUsdcBalanceCached(w);
    console.log(`[${w.label}] ✅ USDC缓冲余额: ${usdcBal2.toFixed(2)} USDC`);
    return { ok: true, didTopUp: true, usdcBal: usdcBal2 };
}

// =======================
// 核心策略：相邻层低买高卖（公共RPC降压版）
// =======================
async function onTick(w, state, currentPrice) {
    bumpDailyTrades(state, 0);

    if (shouldRegrid(state, currentPrice) && canRegrid(state)) {
        console.log(`\n🧭 价格跑出网格区间，重建网格：newBase=$${currentPrice.toFixed(2)}`);
        doRegrid(state, currentPrice);
        saveState(w.keypair.publicKey.toBase58(), state);
        return 0;
    }

    const lastPrice = state.lastPrice;
    if (lastPrice == null) {
        state.lastPrice = currentPrice;
        return 0;
    }

    let trades = 0;

    // (1) 先卖出：上穿目标层卖出
    for (const p of [...state.positions]) {
        if (trades >= MAX_TRADES_PER_TICK) break;

        const targetPrice = state.grid.levels[p.targetIndex]?.price;
        if (targetPrice == null) continue;

        if (lastPrice <= targetPrice && currentPrice > targetPrice) {
            const balanceSOL = await getBalanceSOLCached(w);
            if (balanceSOL < p.amountSol + MIN_BALANCE_SOL) {
                console.warn(`[${w.label}] ⚠️ SOL不足，无法卖出 P#${p.id} (余额 ${balanceSOL.toFixed(4)} SOL)`);
                continue;
            }

            const lamports = Math.floor(p.amountSol * LAMPORTS_PER_SOL);

            console.log(
                `\n📈 上穿目标层 ${p.targetIndex}($${targetPrice.toFixed(2)}) → 卖出 P#${p.id} ${p.amountSol.toFixed(4)} SOL`
            );

            const r = await doSwap(w, SOL_MINT, USDC_MINT, lamports, `卖出SOL@目标层${p.targetIndex}`);
            if (r.ok) {
                state.positions = state.positions.filter((x) => x.id !== p.id);
                trades++;
                bumpDailyTrades(state, 1);
                saveState(w.keypair.publicKey.toBase58(), state);
                await sleep(POST_TRADE_COOLDOWN_MS);
            }
        }
    }

    // (2) 买入前：USDC 缓冲（节流）
    await ensureUsdcBuffer(w, state, currentPrice);

    // (3) 再买入：下穿 entry 层买入，绑定 target=i+1
    // 注意：这里为了减少 RPC，不要在循环里频繁查余额
    const usdcBalSnapshot = await getUsdcBalanceCached(w);
    const solBalSnapshot = await getBalanceSOLCached(w);

    for (let i = 0; i < state.grid.levels.length - 1; i++) {
        if (trades >= MAX_TRADES_PER_TICK) break;

        const entryPrice = state.grid.levels[i].price;

        if (lastPrice >= entryPrice && currentPrice < entryPrice) {
            if (countPositionsAtLevel(state, i) >= MAX_POS_PER_LEVEL) continue;

            if (solBalSnapshot < MIN_BALANCE_SOL) {
                console.warn(`[${w.label}] ⚠️ SOL gas不足 (${solBalSnapshot.toFixed(4)}), 跳过买入`);
                break;
            }

            let amountSol = randFloat(MIN_TRADE_SOL, MAX_TRADE_SOL);
            amountSol = clamp(amountSol, 0.0001, 1000);

            const needUsdc = amountSol * currentPrice;
            if (usdcBalSnapshot < needUsdc) {
                console.warn(`[${w.label}] ⚠️ USDC不足 (${usdcBalSnapshot.toFixed(2)} < ${needUsdc.toFixed(2)}), 跳过买入`);
                continue;
            }

            const usdcAmount = Math.floor(needUsdc * USDC_DECIMALS);

            console.log(
                `\n📉 下穿买入层 ${i}($${entryPrice.toFixed(2)}) → 买入 ${amountSol.toFixed(4)} SOL (约 $${needUsdc.toFixed(2)} USDC)`
            );

            const r = await doSwap(w, USDC_MINT, SOL_MINT, usdcAmount, `买入SOL@层${i}`);
            if (r.ok) {
                state.positions.push({
                    id: state.nextPosId++,
                    entryIndex: i,
                    targetIndex: i + 1,
                    amountSol,
                    entryPrice,
                    createdAt: Date.now(),
                });
                trades++;
                bumpDailyTrades(state, 1);
                saveState(w.keypair.publicKey.toBase58(), state);
                await sleep(POST_TRADE_COOLDOWN_MS);
            }
        }
    }

    state.lastPrice = currentPrice;

    if (trades > 0) {
        console.log(
            `\n📊 Pyth SOL=$${currentPrice.toFixed(2)} | open=${state.positions.length} | dailyTrades=${state.daily?.trades ?? 0}`
        );
        console.log(`✅ 本tick成交: ${trades} | 今日累计: ${state.daily?.trades ?? 0}`);
    }

    return trades;
}

// =======================
// 主循环
// =======================
async function main() {
    console.log(`🔥 公共RPC抗429版启动：Pyth触发 + Jupiter成交`);
    console.log(`钱包: ${worker.keypair.publicKey.toBase58()}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log(`Pyth: ${PYTH_HERMES_URL} | query=${PYTH_QUERY} | asset_type=${PYTH_ASSET_TYPE}`);
    console.log(`网格: COUNT=${GRID_COUNT}, RANGE=±${GRID_RANGE_PERCENT}% | MAX_POS_PER_LEVEL=${MAX_POS_PER_LEVEL}`);
    console.log(`随机下单: SOL ${MIN_TRADE_SOL} ~ ${MAX_TRADE_SOL}`);
    console.log(`USDC缓冲: TARGET=${TARGET_USDC_BUFFER} | MIN_SOL_KEEP=${MIN_SOL_KEEP} | MIN_BALANCE_SOL=${MIN_BALANCE_SOL}`);
    console.log(`轮询: ${PRICE_CHECK_INTERVAL_MS / 1000}s | MAX_TRADES_PER_TICK=${MAX_TRADES_PER_TICK}`);
    console.log(`缓存: BAL_CACHE_TTL_MS=${BAL_CACHE_TTL_MS} | ENSURE_USDC_INTERVAL_MS=${ENSURE_USDC_INTERVAL_MS}\n`);

    const pk = worker.keypair.publicKey.toBase58();

    console.log("⏳ 解析 Pyth price feed id...");
    const { id: pythId, meta } = await resolvePythPriceIdStrict();
    console.log(`✅ Pyth priceId: ${pythId}`);
    if (meta?.attributes?.symbol || meta?.attributes?.description) {
        console.log(`   symbol=${meta.attributes.symbol} | desc=${meta.attributes.description}`);
    }

    // 如果你之前用错了 feed/网格，请先：rm -rf state
    let state = loadState(pk);
    if (!state) {
        console.log("⏳ 初始化网格：获取 Pyth 基准价...");
        const { price } = await getPythPrice(pythId);
        state = makeEmptyState(initGrid(price), price);
        saveState(pk, state);
        console.log(`✅ 初始化完成：base SOL=$${price.toFixed(2)}`);
    } else {
        console.log("✅ 已加载本地状态：state/ 目录");
    }

    // 初始余额（走缓存）
    const solBal = await getBalanceSOLCached(worker, 0);
    const usdcBal = await getUsdcBalanceCached(worker, 0);
    console.log(`💳 初始余额: SOL=${solBal.toFixed(4)} | USDC=${usdcBal.toFixed(2)}\n`);

    while (true) {
        try {
            const { price, publishTime } = await getPythPrice(pythId);
            const ts = new Date().toLocaleString();
            const last = state.lastPrice ?? price;
            const lag = publishTime ? Math.floor(Date.now() / 1000) - publishTime : null;
            const lagStr = lag != null ? ` | lag=${lag}s` : "";

            console.log(`[${ts}] 💹 Pyth SOL=$${price.toFixed(2)} (last $${last.toFixed(2)})${lagStr} | daily=${state.daily?.trades ?? 0}`);

            await onTick(worker, state, price);
        } catch (e) {
            console.error(`[${new Date().toLocaleString()}] ❌ 异常: ${e.message}`);
        }

        await sleep(PRICE_CHECK_INTERVAL_MS);
    }
}

main().catch((e) => {
    console.error("❌ 启动失败:", e.message);
    process.exit(1);
});
