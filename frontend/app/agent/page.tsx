import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { AgentDashboard } from "@/components/agent/agent-dashboard";

export const metadata: Metadata = {
  title: "Agent · Gorilla Markets",
  description:
    "Watch the agent read live odds, detect a sharp move, decide a bet, and sign inside a custody policy it cannot exceed.",
};

export default function AgentPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader
        eyebrow="The agent"
        title="Reasoning, step by step"
        description="The agent reads a live market, detects a sharp move, and sizes a bet — then a policy-gated wallet signs it. The policy is a hard boundary: a max-spend cap plus a program allow-list the agent physically cannot exceed."
        className="mb-8"
      />
      <AgentDashboard />
    </div>
  );
}
