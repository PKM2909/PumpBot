// tiny health server for Fly
try {
  const express = require("express");
  const app = express();
  app.get("/health", (_, res) => res.send("ok"));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("health on", port));
} catch (e) {
  console.log("health server not started:", e.message);
}


// pumpbot.js — CHDPU AutoPump (admin DM trigger only, progress relayed to group)
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { ethers } = require("ethers");

/* ========= ENV ========= */
const TELEGRAM_BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TELEGRAM_ID    = Number(process.env.ADMIN_TELEGRAM_ID || 0);   // your user id
const GROUP_CHAT_ID        = Number(process.env.GROUP_CHAT_ID || 0);       // target group/channel id

const RPC_URL              = process.env.RPC_URL || "https://rpc.mainnet.taraxa.io/";
const CHAIN_ID             = Number(process.env.CHAIN_ID || 841);
const HOT_WALLET_PRIVATE_KEY = (process.env.HOT_WALLET_PRIVATE_KEY || "").trim();

const ROUTER_ADDR   = process.env.ROUTER_ADDR   || "0x329553E2706859Ab82636950c96A8dbbEb28f14A";
const WTARA_ADDR    = process.env.WTARA_ADDR    || "0x5d0fa4c5668e5809c83c95a7cef3a9dd7c68d4fe";
const TOKEN_CHDPU   = process.env.TOKEN_CHDPU   || "0xaad94Afea296DCF8c97D05dbf3733A245c3Ea78F";
const BURN_ADDR     = (process.env.CHDPU_BURN_ADDRESS || "0x000000000000000000000000000000000000dEaD").toLowerCase();

// Behavior
const BURN_BPS        = Number(process.env.BURN_BPS || 1000);   // 1000 = 10% per chunk
const SLIPPAGE_BPS    = Number(process.env.SLIPPAGE_BPS || 200); // 2% minOut guard (0 = disable)
const GAS_LIMIT_SWAP  = BigInt(process.env.GAS_LIMIT_SWAP || 600000);
const GAS_LIMIT_BURN  = BigInt(process.env.GAS_LIMIT_BURN || 120000);
const DEADLINE_SEC    = Number(process.env.DEADLINE_SEC || 600);
const GAS_BOOST_BPS   = Number(process.env.GAS_BOOST_BPS || 1300); // 1.3x initial gas
const GAS_REPRICE_BPS = Number(process.env.GAS_REPRICE_BPS || 1150); // +15% per retry
const WAIT_TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS || 75000);

/* ========= INIT ========= */
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!HOT_WALLET_PRIVATE_KEY) throw new Error("Missing HOT_WALLET_PRIVATE_KEY");
if (!ADMIN_TELEGRAM_ID) throw new Error("Missing ADMIN_TELEGRAM_ID");
if (!GROUP_CHAT_ID) throw new Error("Missing GROUP_CHAT_ID");

const bot      = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const signer   = new ethers.Wallet(HOT_WALLET_PRIVATE_KEY, provider);

/* ========= ABIs ========= */
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)"
];

const erc20Iface  = new ethers.Interface(ERC20_ABI);
const routerIface = new ethers.Interface(ROUTER_ABI);
const chdpu       = new ethers.Contract(TOKEN_CHDPU, ERC20_ABI, signer);

/* ========= Helpers ========= */
const brief = (e) => (e?.reason || e?.message || String(e)).slice(0, 250);
const fmt2  = (wei, dec) => Number(ethers.formatUnits(wei, dec))
  .toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const pct   = (i, total) => `${Math.round((i/total)*100)}% complete`;

async function gasPriceLegacyBoosted(multBps = 1000) {
  let gp = 0n;
  try { const hex = await provider.send("eth_gasPrice", []); if (hex) gp = BigInt(hex); } catch {}
  if (gp <= 0n) gp = 1_000_000_000n; // 1 gwei fallback
  return (gp * BigInt(multBps)) / 1000n;
}
async function waitWithTimeout(txHash, timeoutMs) {
  return await provider.waitForTransaction(txHash, 1, timeoutMs).catch(() => null);
}

/* ========= Core: one swap + burn delta ========= */
async function swapAndBurnDelta(amountTara, dec) {
  const amountInWei = ethers.parseEther(String(amountTara));
  const path = [WTARA_ADDR, TOKEN_CHDPU];

  // minOut (optional)
  let minOut = 0n;
  if (SLIPPAGE_BPS > 0) {
    try {
      const quoted = await provider.call({
        to: ROUTER_ADDR,
        data: routerIface.encodeFunctionData("getAmountsOut", [amountInWei, path]),
      });
      const decoded = routerIface.decodeFunctionResult("getAmountsOut", quoted);
      const expOut  = BigInt(decoded[0][decoded[0].length - 1]);
      minOut = (expOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
    } catch {}
  }

  const before = await chdpu.balanceOf(signer.address);

  const callData = routerIface.encodeFunctionData(
    "swapExactETHForTokensSupportingFeeOnTransferTokens",
    [minOut, path, signer.address, Math.floor(Date.now()/1000) + DEADLINE_SEC]
  );

  // use a fixed base nonce; reprice uses SAME nonce
  const baseNonce = await provider.getTransactionCount(signer.address, "pending");
  let attempt = 0, mined = null, lastHash = null, gasMult = GAS_BOOST_BPS;

  while (attempt < 3 && !mined) {
    const gasPrice = await gasPriceLegacyBoosted(gasMult);
    const tx = {
      type: 0,
      chainId: CHAIN_ID,
      nonce: baseNonce,                 // number
      to: ROUTER_ADDR,
      value: amountInWei,               // bigint
      data: callData,
      gasLimit: GAS_LIMIT_SWAP,         // bigint
      gasPrice,                         // bigint
    };
    const raw = await signer.signTransaction(tx);
    lastHash = await provider.send("eth_sendRawTransaction", [raw]).catch(() => null);
    if (lastHash) {
      mined = await waitWithTimeout(lastHash, WAIT_TIMEOUT_MS);
      if (mined && mined.status !== 1) throw new Error("Swap reverted");
    }
    if (!mined) { attempt++; gasMult = Math.floor(gasMult * (GAS_REPRICE_BPS / 1000)); }
  }
  if (!mined) throw new Error("Swap not mined in time");

  const after  = await chdpu.balanceOf(signer.address);
  const delta  = after - before;        // bigint
  if (delta <= 0n) return { receivedWei: 0n, burnedWei: 0n };

  let burnWei = (delta * BigInt(BURN_BPS)) / 10000n;
  if (burnWei > delta) burnWei = delta;

  if (burnWei > 0n) {
    const burnData = erc20Iface.encodeFunctionData("transfer", [BURN_ADDR, burnWei]);
    const burnNonce = baseNonce + 1;    // number
    const gp = await gasPriceLegacyBoosted(GAS_BOOST_BPS);
    const burnTx = {
      type: 0,
      chainId: CHAIN_ID,
      nonce: burnNonce,                 // number
      to: TOKEN_CHDPU,
      value: 0n,
      data: burnData,
      gasLimit: GAS_LIMIT_BURN,
      gasPrice: gp,
    };
    const burnRaw  = await signer.signTransaction(burnTx);
    const burnHash = await provider.send("eth_sendRawTransaction", [burnRaw]);
    const burnRcpt = await waitWithTimeout(burnHash, WAIT_TIMEOUT_MS);
    if (!burnRcpt || burnRcpt.status !== 1) throw new Error("Burn tx not confirmed");
  }

  return { receivedWei: delta, burnedWei: burnWei };
}

/* ========= Runner: posts to GROUP only ========= */
async function runPumpToGroup(totalTara, splits) {
  const dec = await chdpu.decimals();
  const per = totalTara / splits;

  // initial message in GROUP
  const startMsg = await bot.sendMessage(GROUP_CHAT_ID, `⏳ Autopump in progress…\n\nProgress: 0% complete`);
  const chatId = startMsg.chat.id, msgId = startMsg.message_id;

  let totalRecv = 0n, totalBurn = 0n;

  for (let i = 1; i <= splits; i++) {
    try {
      const { receivedWei, burnedWei } = await swapAndBurnDelta(per, dec);
      totalRecv += receivedWei;
      totalBurn += burnedWei;

      const body =
        `⏳ Autopump in progress…\n\n` +
        `Progress: ${pct(i, splits)}\n` +
        `Last: recv ${fmt2(receivedWei, dec)} CHDPU | burn ${fmt2(burnedWei, dec)} CHDPU\n` +
        `Totals: recv ${fmt2(totalRecv, dec)} | burn ${fmt2(totalBurn, dec)}`;
      await bot.editMessageText(body, { chat_id: chatId, message_id: msgId });
    } catch (e) {
      await bot.editMessageText(
        `⏳ Autopump in progress…\n\n❌ Chunk failed: ${brief(e)}`,
        { chat_id: chatId, message_id: msgId }
      );
      throw e; // bubble up so DM gets error too
    }
  }

  const totalRecvNum = Number(ethers.formatUnits(totalRecv, dec));
  const chdpuPerTara = totalRecvNum > 0 ? (totalRecvNum / totalTara) : 0;

  const summary =
    `✅ AutoPump complete\n\n` +
    `💵 1 TARA = ${chdpuPerTara.toFixed(2)} $CHDPU 💵 \n\n` +
    `• Total received: ${fmt2(totalRecv, dec)} CHDPU\n` +
    `• Burned (10% of buys): ${fmt2(totalBurn, dec)} CHDPU 🔥\n` +
    `• To Treasury: ${fmt2(totalRecv - totalBurn, dec)} CHDPU to fuel the TCCP`;
  await bot.editMessageText(summary, { chat_id: chatId, message_id: msgId });
}

/* ========= Commands ========= */
/**
 * ONLY admin, ONLY from DM. Examples:
 * /pump 10          -> 10 TARA, default 10 buys
 * /pump 10 5        -> 10 TARA, 5 buys
 * /pump 10 /5       -> 10 TARA, 5 buys
 */
bot.onText(/^\/wallet$/i, async (msg) => {
  if (msg.chat.type !== "private" || msg.from.id !== ADMIN_TELEGRAM_ID) return;

  try {
    let lines = [`Wallet: \`${signer.address}\``];

    // TARA balance (4 decimals, commas)
    const taraBal = await provider.getBalance(signer.address);
    const taraFmt = Number(ethers.formatEther(taraBal)).toFixed(4);
    lines.push(`🟢TARA: ${Number(taraFmt).toLocaleString()} TARA`);

    // CHDPU balance (2 decimals, commas)
    if (chdpu) {
      const dec = await chdpu.decimals();
      const chdpuBal = await chdpu.balanceOf(signer.address);
      const chdpuFmt = Number(ethers.formatUnits(chdpuBal, dec)).toFixed(2);
      lines.push(`💵CHDPU: ${Number(chdpuFmt).toLocaleString()} CHDPU`);
    } else {
      lines.push("CHDPU: (contract not configured)");
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (e) {
    console.error("/wallet error", e.message);
    bot.sendMessage(msg.chat.id, "Could not fetch wallet balances.");
  }
});


bot.onText(/^\/pump\s+([\d.]+)(?:\s*(?:\/|\s)\s*(\d+))?$/i, async (msg, m) => {
  // must be DM and admin
  if (msg.chat.type !== "private") return;
  if (msg.from.id !== ADMIN_TELEGRAM_ID) return bot.sendMessage(msg.chat.id, "Unauthorized.");

  const total = Number(m[1]);
  const splits = m[2] ? Number(m[2]) : 10;
  if (!Number.isFinite(total) || total <= 0) return bot.sendMessage(msg.chat.id, "❌ Invalid TARA amount.");
  if (!Number.isFinite(splits) || splits <= 0) return bot.sendMessage(msg.chat.id, "❌ Invalid splits.");

  // DM ack only; all progress goes to GROUP
  await bot.sendMessage(msg.chat.id, `Starting autopump: ${total} TARA in ${splits} buys. Relaying progress to the group…`);

  try {
    await runPumpToGroup(total, splits);
    await bot.sendMessage(msg.chat.id, `✅ Autopump finished. Summary posted in group.`);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Autopump error: ${brief(e)}`);
  }
});

console.log("PumpBot running with group relay.", {
  chainId: CHAIN_ID,
  group: GROUP_CHAT_ID,
  router: ROUTER_ADDR,
  WTARA: WTARA_ADDR,
  chdpu: TOKEN_CHDPU,
  burn: BURN_ADDR
});
