import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { SettlementView } from "@/components/settlement/settlement-view";

export const metadata: Metadata = {
  title: "Settlement · Gorilla Markets",
  description:
    "The centerpiece: a market settled by TxODDS's own on-chain Merkle proof. Open the proof viewer to watch a fixture stat fold up into the committed daily root.",
};

export default function SettlementPage() {
  return (
    <div className="py-12">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <PageHeader
          eyebrow="Settlement"
          title="Settled by proof, not an admin"
          description="settle hands a 3-stage Merkle proof to TxODDS's on-chain oracle, which verifies it against its own committed root and evaluates the market's predicate. The program never decides — the proof does, and a tampered proof reverts."
          className="mb-8"
        />
      </div>
      <SettlementView />
    </div>
  );
}
