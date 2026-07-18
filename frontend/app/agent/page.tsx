import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { AgentDashboard } from "@/components/agent/agent-dashboard";

export const metadata: Metadata = {
  title: "Agent · Gorilla Markets",
  description:
    "A recorded replay of real captured World Cup odds, run through the real sharp-move detector — ending at a real, policy-gated stake on Solana devnet.",
};

export default function AgentPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader
        eyebrow="The agent"
        title="Reasoning, step by step"
        description="The odds below are a recorded replay of real captured TxLINE records, run through the real detector — not a live feed and not a script. The stake it ends at is real and on Solana devnet, read live from the program."
        className="mb-8"
      />
      <AgentDashboard />
    </div>
  );
}
