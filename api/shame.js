// Wall of shame: wallets caught buying in the launch block of coins checked on the site.
//   GET  /api/shame                 -> top offenders
//   GET  /api/shame?wallets=a,b,c   -> rap sheet for those wallets
//   POST /api/shame {mint, symbol, createSig, buys:[{wallet, sig}]}
// Every POSTed buy is re-checked on-chain before it is saved, so nobody can frame a wallet.
// Env: RPC_URL, plus KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN (Vercel → Storage → Upstash Redis).
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

// Vercel's Upstash integration names these KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmds) {
  const r = await fetch(REDIS_URL + "/pipeline", {
    method: "POST",
    headers: { authorization: "Bearer " + REDIS_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmds),
  });
  return (await r.json()).map(x => x.result);
}

async function getTx(sig) {
  return rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
}

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (r.status === 429) { await new Promise(ok => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
    return (await r.json()).result;
  }
  throw new Error("rpc rate limited");
}

// Every transaction in the launch block, by signature (one call instead of one per buy).
async function blockTxs(slot) {
  const block = await rpc("getBlock", [slot, { transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: 1 }]);
  return new Map((block?.transactions || []).map(tx => [tx.transaction.signatures[0], tx]));
}

const hashToObj = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = JSON.parse(arr[i + 1]); return o; };

function createsMint(tx, mint) {
  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions || []).flatMap(i => i.instructions)];
  return all.some(ix => /^initializeMint2?$/.test(ix.parsed?.type) && ix.parsed.info?.mint === mint);
}

function boughtIn(tx, mint, wallet) {
  const keys = tx.transaction.message?.accountKeys || tx.transaction.accountKeys;
  if (!keys.some(k => k.pubkey === wallet && k.signer)) return false;
  const sum = list => (list || []).filter(b => b.mint === mint && b.owner === wallet).reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
  return sum(tx.meta.postTokenBalances) > sum(tx.meta.preTokenBalances);
}

async function report(body) {
  const { mint, symbol, createSig } = body;
  const buys = (body.buys || []).slice(0, 30).filter(b => B58.test(b.wallet) && B58.test(b.sig));
  if (!B58.test(mint) || !B58.test(createSig) || !buys.length) return { status: 400, json: { error: "bad report" } };
  const [fresh] = await redis([["SET", "m:" + mint, "1", "NX"]]);
  if (!fresh) return { status: 200, json: { saved: 0, note: "already recorded" } };

  const create = await getTx(createSig);
  if (!create || create.meta.err || !createsMint(create, mint)) {
    await redis([["DEL", "m:" + mint]]);
    return { status: 422, json: { error: "createSig does not create this mint" } };
  }
  const dev = create.transaction.message.accountKeys[0].pubkey;
  const launch = await blockTxs(create.slot);
  const caught = buys.filter(b => {
    const tx = launch.get(b.sig);
    return b.wallet !== dev && tx && !tx.meta.err && boughtIn(tx, mint, b.wallet);
  });
  if (!caught.length) return { status: 200, json: { saved: 0 } };
  const entry = b => JSON.stringify({ sym: String(symbol || "").slice(0, 20), sig: b.sig, t: create.blockTime });
  const added = await redis(caught.map(b => ["HSET", "w:" + b.wallet, mint, entry(b)]));
  const bumps = caught.filter((b, i) => added[i] === 1).map(b => ["ZINCRBY", "lb", "1", b.wallet]);
  if (bumps.length) await redis(bumps);
  return { status: 200, json: { saved: caught.length } };
}

async function lookup(wallets) {
  const list = wallets.split(",").filter(w => B58.test(w)).slice(0, 60);
  if (!list.length) return {};
  const res = await redis(list.map(w => ["HGETALL", "w:" + w]));
  const out = {};
  list.forEach((w, i) => { const h = hashToObj(res[i]); if (Object.keys(h).length) out[w] = h; });
  return out;
}

async function top() {
  const [z] = await redis([["ZREVRANGE", "lb", "0", "19", "WITHSCORES"]]);
  const rows = [];
  for (let i = 0; i < (z || []).length; i += 2) rows.push({ wallet: z[i], count: Number(z[i + 1]) });
  const sheets = rows.length ? await redis(rows.map(r => ["HGETALL", "w:" + r.wallet])) : [];
  rows.forEach((r, i) => { r.coins = hashToObj(sheets[i]); });
  return rows;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body);
      const r = await report(body || {});
      return res.status(r.status).json(r.json);
    }
    if (req.query.wallets) return res.status(200).json(await lookup(String(req.query.wallets)));
    res.setHeader("cache-control", "s-maxage=30");
    return res.status(200).json(await top());
  } catch (e) {
    return res.status(500).json({ error: "shame store unavailable" });
  }
};
