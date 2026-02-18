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

// =======================
// 配置
// =======================
const RPC_URL = process.env.SOL_RPC_URL || "https://api.mainnet-beta.solana.com";
const USDC_MINT = process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const JUP_API_KEY = process.env.JUP_API_KEY || "";
const JUP_BASE = "https://api.jup.ag/ultra/v1";

const GRID_COUNT = parseInt(process.env.GRID_COUNT || "10", 10);
const GRID_RANGE_PERCENT = parseFloat(process.env.GRID_RANGE_PERCENT || "10");

const MIN_TRADE_SOL = parseFloat(process.env.MIN_TRADE_SOL || "0.002");
const MAX_TRADE_SOL = parseFloat(process.env.MAX_TRADE_SOL || "0.006");

const PRICE_CHECK_INTERVAL_MS = parseInt(process.env.PRICE_CHECK_INTERVAL_MS || "30000", 10);
const MAX_TRADES_PER_TICK = parseInt(process.env.MAX_TRADES_PER_TICK || "2", 10);
const POST_TRADE_COOLDOWN_MS = parseInt(process.env.POST_TRADE_COOLDOWN_MS || "1500", 10);

const MIN_BALANCE_SOL = parseFloat(process.env.MIN_BALANCE_SOL || "0.01");

const TARGET_USDC_BUFFER = parseFloat(process.env.TARGET_USDC_BUFFER || "5");
const MIN_SOL_KEEP = parseFloat(process.env.MIN_SOL_KEEP || "0.08");

const USDC_DECIMALS = 1_000_000;

if (!process.env.SOL_PRIVATE_KEYS) throw new Error("❌ .env 中 SOL_PRIVATE_KEYS 为空");
if (!JUP_API_KEY) throw new Error("❌ .env 中 JUP_API_KEY 为空");

if (GRID_COUNT < 2) throw new Error("❌ GRID_COUNT 建议 >= 2");
if (GRID_RANGE_PERCENT <= 0) throw new Error("❌ GRID_RANGE_PERCENT 必须 > 0");
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

// =======================
// 工具：随机数/文件状态
// =======================
function randFloat(min, max) {
    return min + Math.random() * (max - min);
}
function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

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
// 账户加载（单钱包）
// =======================
const keyList = process.env.SOL_PRIVATE_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
const kp = Keypair.fromSecretKey(bs58.decode(keyList[0]));

const proxyAgent = proxyList.length > 0 ? buildProxyAgent(proxyList[0]) : null;

const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    fetchMiddleware: proxyAgent
        ? (info, init, fetch_) => fetch_(info, { ...init, agent: proxyAgent })
        : undefined,
});

const worker = {
    label: "W1",
    keypair: kp,
    proxyAgent,
    connection,
};

// =======================
// fetch: retry + timeout
// =======================
async function fetchJsonWithRetry(url, options = {}, retries = 3, timeoutMs = 15000) {
    for (let i = 0; i < retries; i++) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(t);

            if (res.ok) return await res.json();

            if (res.status === 429) {
                await sleep(2000 + i * 1500);
                continue;
            }

            const body = await res.text();
            throw new Error(`HTTP ${res.status}: ${body}`);
        } catch (e) {
            clearTimeout(t);
            if (i === retries - 1) throw e;
            await sleep(1200 + i * 1000);
        }
    }
}

// =======================
// 余额：SOL + USDC
// =======================
async function getBalanceSOL(w) {
    const lamports = await w.connection.getBalance(w.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
}

async function getTokenBalanceUI(w, mintStr) {
    const mint = new PublicKey(mintStr);
    const res = await w.connection.getParsedTokenAccountsByOwner(w.keypair.publicKey, { mint });
    if (!res.value || res.value.length === 0) return 0;

    let total = 0;
    for (const acc of res.value) {
        const ui = acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
        total += ui;
    }
    return total;
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
// 价格：用 1 SOL -> USDC 报价推算
// =======================
async function getSOLPrice(w) {
    const order = await getOrder(w, SOL_MINT, USDC_MINT, LAMPORTS_PER_SOL);
    if (!order || !order.outAmount) throw new Error("无法获取 SOL 价格报价");
    return parseInt(order.outAmount, 10) / USDC_DECIMALS;
}

// =======================
// 交易确认
// =======================
async function confirmSignature(w, signature, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const st = await w.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const s = st?.value?.[0];
        if (s) {
            if (s.err) throw new Error(`链上失败: ${JSON.stringify(s.err)}`);
            if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return true;
        }
        await sleep(2000);
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

    // 严格判定
    if (!res || res.status !== "Success" || !res.signature) {
        console.error(`[${w.label}] ❌ ${label} 执行失败:`, JSON.stringify(res));
        return { ok: false };
    }

    console.log(`[${w.label}] ⛓️ 已提交: https://solscan.io/tx/${res.signature}`);
    await confirmSignature(w, res.signature);
    console.log(`[${w.label}] ✅ 已确认: ${label}`);

    return { ok: true, signature: res.signature };
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
        levels.push({
            index: i,
            price: parseFloat((low + step * i).toFixed(4)),
        });
    }

    return { basePrice, levels };
}

function makeEmptyState(grid, lastPrice) {
    return {
        grid,
        lastPrice,
        positions: [], // {id, entryIndex, targetIndex, amountSol, entryPrice, createdAt}
        nextPosId: 1,
        lastTopUpAt: null,
    };
}

function findOpenPositionByEntryIndex(state, entryIndex) {
    return state.positions.find((p) => p.entryIndex === entryIndex);
}

function printStatus(state, currentPrice) {
    console.log(`\n📊 SOL=$${currentPrice.toFixed(2)} | open=${state.positions.length}`);
    for (const p of state.positions) {
        const tp = state.grid.levels[p.targetIndex]?.price;
        console.log(
            `  - P#${p.id} entry=${p.entryIndex}($${p.entryPrice}) -> target=${p.targetIndex}($${tp}) amt=${p.amountSol.toFixed(4)} SOL`
        );
    }
}

// =======================
// 方案B：USDC 缓冲自动补仓
// =======================
async function ensureUsdcBuffer(w, state, currentPrice) {
    const usdcBal = await getTokenBalanceUI(w, USDC_MINT);
    if (usdcBal >= TARGET_USDC_BUFFER) return { ok: true, didTopUp: false, usdcBal };

    const solBal = await getBalanceSOL(w);

    // 可卖 SOL：扣掉保留 SOL + gas 安全垫
    const sellableSol = solBal - MIN_SOL_KEEP - MIN_BALANCE_SOL;
    if (sellableSol <= 0) {
        console.warn(
            `[${w.label}] ⚠️ USDC不足(${usdcBal.toFixed(2)}/${TARGET_USDC_BUFFER}), 但SOL可卖不足(SOL=${solBal.toFixed(4)}).`
        );
        return { ok: false, didTopUp: false, usdcBal };
    }

    const needUsdc = TARGET_USDC_BUFFER - usdcBal;

    // 估算需要卖出多少 SOL（加5%缓冲）
    const solToSell = Math.min(sellableSol, (needUsdc / currentPrice) * 1.05);
    if (solToSell < 0.0005) {
        console.warn(`[${w.label}] ⚠️ 需要补的USDC很小(${needUsdc.toFixed(2)}), 不做补仓`);
        return { ok: true, didTopUp: false, usdcBal };
    }

    const lamports = Math.floor(solToSell * LAMPORTS_PER_SOL);

    console.log(
        `\n💱 USDC不足(${usdcBal.toFixed(2)}/${TARGET_USDC_BUFFER}), 卖出约 ${solToSell.toFixed(4)} SOL 建立缓冲`
    );

    const r = await doSwap(w, SOL_MINT, USDC_MINT, lamports, `补USDC缓冲(目标${TARGET_USDC_BUFFER})`);
    if (!r.ok) return { ok: false, didTopUp: false, usdcBal };

    const usdcBal2 = await getTokenBalanceUI(w, USDC_MINT);
    console.log(`[${w.label}] ✅ USDC缓冲余额: ${usdcBal2.toFixed(2)} USDC`);

    state.lastTopUpAt = Date.now();
    saveState(w.keypair.publicKey.toBase58(), state);

    return { ok: true, didTopUp: true, usdcBal: usdcBal2 };
}

// =======================
// 核心策略：相邻层配对低买高卖
// =======================
async function onTick(w, state, currentPrice) {
    const lastPrice = state.lastPrice;
    if (lastPrice == null) {
        state.lastPrice = currentPrice;
        return 0;
    }

    let trades = 0;

    // (1) 先卖出：持仓上穿目标层就卖
    for (const p of [...state.positions]) {
        if (trades >= MAX_TRADES_PER_TICK) break;

        const targetPrice = state.grid.levels[p.targetIndex]?.price;
        if (targetPrice == null) continue;

        if (lastPrice <= targetPrice && currentPrice > targetPrice) {
            const balanceSOL = await getBalanceSOL(w);
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
                saveState(w.keypair.publicKey.toBase58(), state);
                await sleep(POST_TRADE_COOLDOWN_MS);
            }
        }
    }

    // (2) 买入前：确保 USDC 缓冲
    await ensureUsdcBuffer(w, state, currentPrice);

    // (3) 再买入：下穿某层，且该层没有持仓，则买入并绑定目标层 i+1
    for (let i = 0; i < state.grid.levels.length - 1; i++) {
        if (trades >= MAX_TRADES_PER_TICK) break;

        const entryPrice = state.grid.levels[i].price;

        if (lastPrice >= entryPrice && currentPrice < entryPrice) {
            if (findOpenPositionByEntryIndex(state, i)) continue;

            // 随机 SOL 数量
            let amountSol = randFloat(MIN_TRADE_SOL, MAX_TRADE_SOL);
            amountSol = clamp(amountSol, 0.0001, 1000);

            // 计算需要 USDC
            const needUsdc = amountSol * currentPrice;
            const usdcBal = await getTokenBalanceUI(w, USDC_MINT);

            if (usdcBal < needUsdc) {
                console.warn(`[${w.label}] ⚠️ USDC不足 (${usdcBal.toFixed(2)} < ${needUsdc.toFixed(2)}), 跳过买入`);
                continue;
            }

            // 还要确保 SOL 有 gas
            const solBal = await getBalanceSOL(w);
            if (solBal < MIN_BALANCE_SOL) {
                console.warn(`[${w.label}] ⚠️ SOL gas不足 (${solBal.toFixed(4)}), 跳过买入`);
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
                saveState(w.keypair.publicKey.toBase58(), state);
                await sleep(POST_TRADE_COOLDOWN_MS);
            }
        }
    }

    state.lastPrice = currentPrice;
    if (trades > 0) printStatus(state, currentPrice);

    return trades;
}

// =======================
// 主循环
// =======================
async function main() {
    console.log(`🔥 SOL 网格（相邻层低买高卖 + USDC缓冲自动补仓）启动`);
    console.log(`钱包: ${worker.keypair.publicKey.toBase58()}`);
    console.log(`网格: COUNT=${GRID_COUNT}, RANGE=±${GRID_RANGE_PERCENT}%`);
    console.log(`随机下单: SOL ${MIN_TRADE_SOL} ~ ${MAX_TRADE_SOL}`);
    console.log(`USDC缓冲: TARGET=${TARGET_USDC_BUFFER}, 保留SOL=${MIN_SOL_KEEP}, gas垫=${MIN_BALANCE_SOL}`);
    console.log(`轮询: ${PRICE_CHECK_INTERVAL_MS / 1000}s, 每tick最多${MAX_TRADES_PER_TICK}笔\n`);

    const pk = worker.keypair.publicKey.toBase58();
    let state = loadState(pk);

    if (!state) {
        console.log("⏳ 初始化网格：获取基准价格...");
        const basePrice = await getSOLPrice(worker);
        const grid = initGrid(basePrice);
        state = makeEmptyState(grid, basePrice);
        saveState(pk, state);
        console.log(`✅ 初始化完成：base SOL=$${basePrice.toFixed(2)}`);
    } else {
        console.log("✅ 已加载本地状态：state/ 目录");
    }

    // 打印当前 token account 数量（排查用）
    const mint = new PublicKey(USDC_MINT);
    const tokenAccs = await connection.getParsedTokenAccountsByOwner(kp.publicKey, { mint });
    console.log(`USDC token accounts: ${tokenAccs.value.length}`);

    const solBal = await getBalanceSOL(worker);
    const usdcBal = await getTokenBalanceUI(worker, USDC_MINT);
    console.log(`💳 初始余额: SOL=${solBal.toFixed(4)} | USDC=${usdcBal.toFixed(2)}\n`);

    while (true) {
        try {
            const price = await getSOLPrice(worker);
            const ts = new Date().toLocaleString();
            const last = state.lastPrice ?? price;
            console.log(`[${ts}] 💹 SOL=$${price.toFixed(2)} (last $${last.toFixed(2)})`);

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
