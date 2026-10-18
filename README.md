# Is it Diddy bundled?

Paste a Solana CA → finds the launch block, shows every wallet that bought in it, grades the coin A/B/C/F,
and puts caught wallets on a shared **Wall of shame** with Solscan receipts.

## Files
- `index.html` — the whole site
- `api/rpc.js` — Vercel function that forwards read-only Solana RPC calls (keeps your RPC key secret)
- `api/shame.js` — Vercel function for the wall of shame (re-checks every report on-chain before saving)
- `serve.py` — run it all locally: `python serve.py` then open http://127.0.0.1:8791

## Put it online (free, ~15 minutes)
1. **RPC key:** sign up at helius.dev (free plan) and copy your mainnet RPC URL.
   The public Solana RPC blocks browsers and rate-limits hard, so you need this.
2. **GitHub:** make a new repo and upload everything in this folder.
3. **Vercel:** vercel.com → Add New Project → import the repo → Deploy (no build settings needed).
4. **Database for the wall:** in the Vercel project → Storage → add **Upstash Redis** (free).
   It sets `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for you.
5. **Env var:** Project → Settings → Environment Variables → add `RPC_URL` = your Helius URL. Redeploy.
6. Optional: buy a domain and add it under Project → Domains.

## How the grade works
- **Launch block buyers:** wallets (not the dev) whose buy landed in the same block the token was created.
- **Jito:** early buys that paid a Jito tip.
- **Snipers:** buys within 3 blocks of launch.
- **Holding:** how much dev + early wallets still hold (top 20 holders).
- **Repeat:** a wallet in this launch was already caught in another coin's launch block.

Limits: can miss bundlers who spread buys across many blocks or fresh wallets. A clean grade is not "safe."
