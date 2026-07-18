import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";

import { clusterFromGenesisHash, detectCluster } from "@/lib/solana/cluster";

const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function fakeConn(getGenesisHash: () => Promise<string>): Connection {
  return { getGenesisHash } as unknown as Connection;
}

describe("clusterFromGenesisHash", () => {
  it("maps canonical genesis hashes to their cluster", () => {
    expect(clusterFromGenesisHash(DEVNET)).toBe("devnet");
    expect(clusterFromGenesisHash(MAINNET)).toBe("mainnet");
  });

  it("returns 'unknown' for an unrecognised hash rather than assuming a cluster", () => {
    expect(clusterFromGenesisHash("not-a-real-hash")).toBe("unknown");
  });
});

describe("detectCluster", () => {
  it("reads the cluster from the connection's genesis hash", async () => {
    await expect(detectCluster(fakeConn(async () => MAINNET))).resolves.toBe("mainnet");
  });

  it("returns 'unknown' (never throws) when the RPC fails", async () => {
    await expect(
      detectCluster(
        fakeConn(async () => {
          throw new Error("rpc down");
        }),
      ),
    ).resolves.toBe("unknown");
  });
});
