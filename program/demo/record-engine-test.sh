#!/usr/bin/env bash
# Recordable terminal demo of the settlement engine — the REAL Mollusk suite,
# narrated. The narration is context; the `cargo test` output is unfiltered,
# native, and real (RUST_LOG=off only silences log verbosity, never results).
# Never hand-edit the resulting .cast; re-run this to re-record.
#
#   cd program && bash demo/record-engine-test.sh          # paced (for recording)
#   FAST=1 bash demo/record-engine-test.sh                 # no pauses (iterating)
set -uo pipefail
cd "$(dirname "$0")/.."                       # -> program/
export SBF_OUT_DIR="$(pwd)/target/deploy"
export RUST_LOG=off

B=$'\033[1m'; M=$'\033[35m'; C=$'\033[36m'; G=$'\033[32m'; D=$'\033[2m'; X=$'\033[0m'
say() { printf '%b\n' "$1"; [ "${FAST:-0}" = 1 ] || sleep "${2:-0.8}"; }

say ""
say "${B}${M}GORILLA — SETTLEMENT ENGINE${X}  ${D}one engine, settled by proof${X}" 1.2
say ""
say "${D}Two different products settle through ONE shared engine:${X}"
say "${D}  · a betting market  ${X}(who won?)"
say "${D}  · an insurance policy  ${X}(did the thing happen?)"
say "${D}Neither re-checks the proof itself. Neither can skip the safety —${X}"
say "${D}the engine binds every result to its exact game, stat and period.${X}" 1.4
say ""
say "${C}\$ cargo test -p forge-markets-tests${X}" 0.8

# ── the REAL run — native cargo output, nothing filtered ─────────────────────
cargo test -p forge-markets-tests -- --test-threads=1 2>&1 \
  | grep -vE "Compiling|Finished|Running|Doc-tests|^\s*$" \
  | grep -E "^(test |running |test result)"

say ""
say "${G}18 passed.${X}  ${D}The proof is in the names:${X}" 1.0
say "  ${D}gate_two_hop_return_data_survives…  a result survives market→engine→feed${X}"
say "  ${D}predicate_false_settles_no…         it settles NO honestly, not only YES${X}"
say "  ${D}settle_rejects_{fixture,stat,period}_mismatch  can't settle a different fact${X}"
say "  ${D}tampered_proof_reverts_settle       a faked proof pays nobody${X}"
say "  ${B}insurance_…${X}${D}  a DIFFERENT product on the SAME engine${X}"
say "  ${B}insurance_tampered_proof_reverts_and_leaves_funds_untouched${X}" 1.4
say ""
say "${D}A program that is not the market calls the engine, settles by proof,${X}"
say "${D}and reverts on a tampered proof. Reuse you can verify — in one test run.${X}" 1.2
say ""
say "${B}${M}GORILLA${X}  ${D}settled by proof — for our app, and anyone who builds on it${X}" 0.4
