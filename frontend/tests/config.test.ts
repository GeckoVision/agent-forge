import { describe, expect, it } from "vitest";

import {
  explorerAddress,
  explorerTx,
  FORGE_PROGRAM_ID,
  getNetworkConfig,
  rpcEndpoint,
} from "@/lib/solana/config";

describe("explorer links", () => {
  it("builds devnet address/tx links with the cluster query", () => {
    expect(explorerAddress("ADDR", "devnet")).toBe(
      "https://explorer.solana.com/address/ADDR?cluster=devnet",
    );
    expect(explorerTx("SIG", "devnet")).toBe(
      "https://explorer.solana.com/tx/SIG?cluster=devnet",
    );
  });

  it("omits the cluster query for mainnet", () => {
    expect(explorerAddress("ADDR", "mainnet")).toBe(
      "https://explorer.solana.com/address/ADDR",
    );
  });
});

describe("getNetworkConfig", () => {
  it("devnet is live with the real program and a degraded-read fallback", () => {
    const c = getNetworkConfig("devnet");
    expect(c.live).toBe(true);
    expect(c.forgeProgramId.equals(FORGE_PROGRAM_ID)).toBe(true);
    expect(c.fallbackMarkets).toHaveLength(2);
    expect(c.explorerCluster).toBe("devnet");
  });

  it("mainnet-sim is the not-yet-live seam", () => {
    const c = getNetworkConfig("mainnet-sim");
    expect(c.live).toBe(false);
    expect(c.fallbackMarkets).toHaveLength(0);
  });
});

describe("rpcEndpoint", () => {
  it("points at the same-origin proxy with the mode", () => {
    // In node (no window) it uses the localhost fallback origin.
    expect(rpcEndpoint("devnet")).toContain("/api/rpc?mode=devnet");
    expect(rpcEndpoint("mainnet-sim")).toContain("/api/rpc?mode=mainnet-sim");
  });
});
