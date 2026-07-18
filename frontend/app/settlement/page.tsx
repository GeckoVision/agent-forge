import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { SettlementView } from "@/components/settlement/settlement-view";

export const metadata: Metadata = {
  title: "Settlement · Gorilla Markets",
  description:
    "The centerpiece: a market settled by TxODDS's own on-chain Merkle proof. Open the proof viewer to watch a match stat fold up into the committed daily root.",
};

export default function SettlementPage() {
  return (
    <div className="py-12">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <PageHeader
          eyebrow="Settlement"
          title="Settled by proof, not an admin"
          description={
            <>
              {/* Plain language leads — a non-technical viewer must get this in one read. */}
              When a match ends, the result arrives as a signed receipt from the
              sports-data provider. The program checks that receipt itself, on
              chain, and pays out automatically. If the receipt doesn&rsquo;t check
              out, nothing moves — nobody, including us, can change the outcome.
              <span className="mt-2 block text-sm text-muted-foreground/70">
                For the technically curious: the receipt is a 3-stage Merkle proof,
                verified by TxODDS&rsquo;s on-chain oracle against its own committed
                root — a tampered proof reverts.
              </span>
            </>
          }
          className="mb-8"
        />
      </div>
      <SettlementView />
    </div>
  );
}
