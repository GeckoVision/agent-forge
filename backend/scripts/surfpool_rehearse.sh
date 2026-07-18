#!/usr/bin/env bash
# Rehearse the Gorilla on-chain loop against a Surfpool MAINNET FORK — no broadcast.
#
# One command: builds the mainnet-oracle `forge_markets` program, starts a fresh Surfpool
# fork of Solana mainnet (real mainnet accounts pulled on demand — the TxODDS oracle + its
# daily roots), deploys the program to the FORK, and profiles the full loop
# (create_market -> stake -> stake -> settle -> claim) under mainnet parameters via
# surfnet_profileTransaction. NOTHING is ever broadcast to real mainnet; the founder alone
# does that. settle CPIs the REAL mainnet TxODDS oracle (9ExbZ...) and settles Yes.
#
# Prereqs on PATH: surfpool, solana, cargo (+ cargo-build-sbf), and the backend venv at
# backend/.venv. Usage:  bash backend/scripts/surfpool_rehearse.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # backend/scripts
BACKEND="$(dirname "$HERE")"
REPO="$(dirname "$BACKEND")"
PROGRAM="$REPO/program"
FORK_RPC="http://127.0.0.1:8899"
MAINNET_ORACLE="9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"
FORGE_CARGO="$PROGRAM/programs/forge-markets/Cargo.toml"
DEPLOY_KEYS="$PROGRAM/.deploy-keys"
# Isolated target dir for the mainnet build so it NEVER collides with target/deploy (which
# stays the devnet build the Mollusk suite loads). gitignored; first build ~1 min, cached after.
MAINNET_TARGET="$PROGRAM/target-mainnet"
SO_MAINNET="$MAINNET_TARGET/deploy/forge_markets.so"
LOG="$(mktemp)"
SURF_PID=""

SURF_WORKDIR=""
cleanup() {
  [ -n "$SURF_PID" ] && kill "$SURF_PID" 2>/dev/null || true
  [ -n "$SURF_WORKDIR" ] && rm -rf "$SURF_WORKDIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "== 1/4  build forge_markets (mainnet-oracle build, isolated target) =="
CARGO_TARGET_DIR="$MAINNET_TARGET" cargo build-sbf --manifest-path "$FORGE_CARGO" --features mainnet-oracle

echo "== 2/4  start a fresh Surfpool mainnet fork (transaction block mode) =="
# SIGKILL any prior surfpool (it handles SIGTERM slowly) and WAIT for the port to actually
# free — a lingering instance keeps serving its old committed state (a stale market) and
# silently defeats the 'fresh fork' assumption; the new surfpool would fail to bind unnoticed.
pkill -9 -x surfpool 2>/dev/null || true
for _ in $(seq 1 40); do ss -ltn 2>/dev/null | grep -q ":8899" && sleep 0.3 || break; done
# Start surfpool from a clean temp dir: it caches surfnet state under ./.surfpool and reloads
# it on restart, so a stale cache would carry a prior run's committed market. A fresh cwd
# guarantees a truly fresh fork every rehearsal.
SURF_WORKDIR="$(mktemp -d)"
cd "$SURF_WORKDIR"
surfpool start --network mainnet --no-tui --no-deploy \
  --block-production-mode transaction --port 8899 > "$LOG" 2>&1 &
SURF_PID=$!
for _ in $(seq 1 40); do
  curl -s "$FORK_RPC" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"' && break
  sleep 0.5
done
echo "   fork up (surfpool PID $SURF_PID)"

echo "== 3/4  fund authority + deploy forge_markets to the FORK =="
AUTH="$(solana address -k "$DEPLOY_KEYS/deploy-authority.json")"
curl -s "$FORK_RPC" -X POST -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$AUTH\",200000000000]}" >/dev/null
solana program deploy "$SO_MAINNET" \
  --program-id "$DEPLOY_KEYS/forge_markets-keypair.json" \
  --keypair "$DEPLOY_KEYS/deploy-authority.json" \
  --url "$FORK_RPC" 2>&1 | sed 's/^/   /'

echo "== 4/4  profile the loop under mainnet params (NO broadcast) =="
GORILLA_TXORACLE_ID="$MAINNET_ORACLE" PYTHONPATH="$BACKEND" \
  "$BACKEND/.venv/bin/python" "$BACKEND/scripts/profile_surfpool.py"

echo
echo "Rehearsal complete. Tearing down the fork (nothing was broadcast to real mainnet)."
