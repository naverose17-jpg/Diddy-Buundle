// Vercel serverless function: forwards read-only Solana RPC calls so the RPC key stays secret.
// Set RPC_URL in Vercel → Project → Settings → Environment Variables (e.g. your Helius URL).
const ALLOWED = new Set([
  "getTokenSupply",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenLargestAccounts",
  "getMultipleAccounts",
  "getBlock",
]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let body = req.body;
  try { if (typeof body === "string") body = JSON.parse(body); } catch { body = null; }
  if (!body || Array.isArray(body) || !ALLOWED.has(body.method)) {
    return res.status(400).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: "Method not allowed" } });
  }
  const upstream = await fetch(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, method: body.method, params: body.params }),
  });
  res.status(upstream.status).setHeader("content-type", "application/json");
  res.send(await upstream.text());
};
