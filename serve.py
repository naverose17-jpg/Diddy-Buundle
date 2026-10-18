"""Local test server: serves the site and mirrors the Vercel functions in api/.

  /api/rpc    proxies read-only Solana RPC calls (like api/rpc.js)
  /api/shame  wall of shame, stored in shame.local.json instead of Upstash (like api/shame.js)

Usage:  python serve.py [port]
Optional: set RPC_URL to your Helius (or other) RPC URL first.
"""
import json
import os
import re
import sys
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(ROOT, "shame.local.json")
RPC_URL = os.environ.get("RPC_URL", "https://api.mainnet-beta.solana.com")
ALLOWED = {"getTokenSupply", "getSignaturesForAddress", "getTransaction",
           "getTokenLargestAccounts", "getMultipleAccounts", "getBlock"}
B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,88}$")
lock = threading.Lock()


def rpc_raw(method, params):
    req = urllib.request.Request(RPC_URL, method="POST", headers={"content-type": "application/json"},
                                 data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode())
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, r.read()


def rpc(method, params):
    for attempt in range(5):
        try:
            return json.loads(rpc_raw(method, params)[1]).get("result")
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("rpc rate limited")


def get_tx(sig):
    return rpc("getTransaction", [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 1}])


def block_txs(slot):
    """Every transaction in the launch block, by signature (one call instead of one per buy)."""
    block = rpc("getBlock", [slot, {"transactionDetails": "accounts", "rewards": False, "maxSupportedTransactionVersion": 1}])
    return {tx["transaction"]["signatures"][0]: tx for tx in (block or {}).get("transactions", [])}


def load():
    try:
        with open(STORE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"mints": [], "wallets": {}}


def save(db):
    with open(STORE, "w", encoding="utf-8") as f:
        json.dump(db, f)


def creates_mint(tx, mint):
    ixs = tx["transaction"]["message"]["instructions"] + [i for inner in tx["meta"].get("innerInstructions") or [] for i in inner["instructions"]]
    return any(re.match(r"^initializeMint2?$", (ix.get("parsed") or {}).get("type", "") if isinstance(ix.get("parsed"), dict) else "")
               and ix["parsed"].get("info", {}).get("mint") == mint for ix in ixs)


def bought_in(tx, mint, wallet):
    keys = tx["transaction"]["message"]["accountKeys"] if "message" in tx["transaction"] else tx["transaction"]["accountKeys"]
    if not any(k["pubkey"] == wallet and k.get("signer") for k in keys):
        return False
    total = lambda bals: sum(int(b["uiTokenAmount"]["amount"]) for b in bals or [] if b["mint"] == mint and b.get("owner") == wallet)
    return total(tx["meta"].get("postTokenBalances")) > total(tx["meta"].get("preTokenBalances"))


def report(body):
    mint, create_sig = body.get("mint", ""), body.get("createSig", "")
    buys = [b for b in (body.get("buys") or [])[:30] if B58.match(b.get("wallet", "")) and B58.match(b.get("sig", ""))]
    if not B58.match(mint) or not B58.match(create_sig) or not buys:
        return 400, {"error": "bad report"}
    with lock:
        if mint in load()["mints"]:
            return 200, {"saved": 0, "note": "already recorded"}
    create = get_tx(create_sig)
    if not create or create["meta"]["err"] or not creates_mint(create, mint):
        return 422, {"error": "createSig does not create this mint"}
    dev = create["transaction"]["message"]["accountKeys"][0]["pubkey"]
    launch = block_txs(create["slot"])
    caught = [b for b in buys if b["wallet"] != dev and b["sig"] in launch
              and not launch[b["sig"]]["meta"]["err"] and bought_in(launch[b["sig"]], mint, b["wallet"])]
    with lock:
        db = load()
        db["mints"].append(mint)
        for b in caught:
            db["wallets"].setdefault(b["wallet"], {})[mint] = {"sym": str(body.get("symbol") or "")[:20], "sig": b["sig"], "t": create["blockTime"]}
        save(db)
    return 200, {"saved": len(caught)}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/api/shame":
            return super().do_GET()
        db = load()["wallets"]
        wallets = parse_qs(u.query).get("wallets", [""])[0]
        if wallets:
            return self._json(200, {w: db[w] for w in wallets.split(",")[:60] if w in db})
        top = sorted(db.items(), key=lambda kv: -len(kv[1]))[:20]
        self._json(200, [{"wallet": w, "count": len(c), "coins": c} for w, c in top])

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self._json(400, {"error": "bad json"})
        if self.path == "/api/shame":
            return self._json(*report(body))
        if self.path != "/api/rpc":
            return self.send_error(404)
        if body.get("method") not in ALLOWED:
            return self._json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32601, "message": "Method not allowed"}})
        try:
            self._reply(*rpc_raw(body["method"], body.get("params")))
        except urllib.error.HTTPError as e:
            self._reply(e.code, e.read())

    def _json(self, code, obj):
        self._reply(code, json.dumps(obj).encode())

    def _reply(self, code, data):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    print(f"Bundle Check on http://127.0.0.1:{port}  (RPC: {'custom' if 'RPC_URL' in os.environ else 'public'})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=ROOT)).serve_forever()
