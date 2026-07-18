import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { TrackRecord } from "@/components/track/track-record";

export const metadata: Metadata = {
  title: "Track record · Gorilla Markets",
  description:
    "The agent's history — every market, outcome and pot — decoded straight from on-chain program accounts on devnet.",
};

export default function TrackRecordPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader
        eyebrow="Track record"
        title="A record that lives on-chain"
        description="Every market the agent has settled is public program state. This is decoded straight from the chain — win, loss and pot — nothing to trust, everything to verify."
        className="mb-8"
      />
      <TrackRecord />
    </div>
  );
}
