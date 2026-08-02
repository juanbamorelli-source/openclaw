// Handles authenticated owner lifecycle commands without sending them through the model.
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveSkillCommandInvocation } from "../../skills/discovery/chat-commands.js";
import {
  applySkillProposal,
  listSkillProposals,
  quarantineSkillProposal,
  rejectSkillProposal,
} from "../../skills/workshop/service.js";
import { rejectNonOwnerCommand, rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/?skill(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/skill@[^\s]+(?:\s|$)/i;

const USAGE = [
  "Skill Workshop owner commands:",
  "/skill list [query]",
  "/skill apply <proposal-id>",
  "/skill reject <proposal-id> [reason]",
  "/skill quarantine <proposal-id> [reason]",
].join("\n");

type LifecycleAction = "apply" | "reject" | "quarantine";
type ParsedSkillCommand =
  | { kind: "list"; query?: string }
  | { kind: "lifecycle"; action: LifecycleAction; proposalId?: string; reason?: string };

function parseSkillCommand(raw: string): ParsedSkillCommand | null {
  const trimmed = raw.trim();
  if (FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return null;
  }
  const commandMatch = trimmed.match(COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const tokens = trimmed.slice(commandMatch[0].length).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const action = tokens.shift()?.toLowerCase();
  if (action === "list") {
    const query = tokens.join(" ").trim();
    return query ? { kind: "list", query } : { kind: "list" };
  }
  if (action !== "apply" && action !== "reject" && action !== "quarantine") {
    return null;
  }
  const proposalId = tokens.shift();
  const reason = tokens.join(" ").trim();
  return {
    kind: "lifecycle",
    action,
    ...(proposalId ? { proposalId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function formatProposalList(
  proposals: Awaited<ReturnType<typeof listSkillProposals>>["proposals"],
): string {
  if (proposals.length === 0) {
    return "No Skill Workshop proposals match.";
  }
  const lines = proposals.slice(0, 20).map((proposal) => {
    return `• ${proposal.id} — ${proposal.status} — ${proposal.skillKey}`;
  });
  return ["Skill Workshop proposals:", ...lines].join("\n");
}

/**
 * Native chat commands are authenticated before an agent/model run starts. They intentionally
 * call the Workshop service directly, so an owner's exact lifecycle command does not create a
 * second plugin-approval request and a model cannot substitute a different proposal or action.
 */
export const handleSkillWorkshopCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseSkillCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const skillCommands = params.skillCommands ?? (await params.loadSkillCommands?.());
  if (
    skillCommands &&
    resolveSkillCommandInvocation({
      commandBodyNormalized: params.command.commandBodyNormalized,
      skillCommands,
    })
  ) {
    // `/skill <name>` remains a user-skill namespace when that command exists.
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/skill");
  if (unauthorized) {
    return unauthorized;
  }
  const nonOwner = rejectNonOwnerCommand(params, "/skill");
  if (nonOwner) {
    return nonOwner;
  }
  try {
    if (parsed.kind === "list") {
      const listed = await listSkillProposals({ workspaceDir: params.workspaceDir });
      const query = parsed.query?.toLowerCase();
      const proposals = query
        ? listed.proposals.filter((proposal) =>
            [proposal.id, proposal.skillKey, proposal.title, proposal.description]
              .join("\n")
              .toLowerCase()
              .includes(query),
          )
        : listed.proposals;
      return { shouldContinue: false, reply: { text: formatProposalList(proposals) } };
    }

    const proposalId = parsed.proposalId;
    if (!proposalId) {
      return { shouldContinue: false, reply: { text: USAGE } };
    }

    const input = {
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      proposalId,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    };
    if (parsed.action === "apply") {
      const result = await applySkillProposal(input);
      return {
        shouldContinue: false,
        reply: { text: `✅ Applied ${result.record.id} to ${result.record.target.skillKey}.` },
      };
    }
    if (parsed.action === "reject") {
      const result = await rejectSkillProposal(input);
      return {
        shouldContinue: false,
        reply: { text: `✅ Rejected ${result.id} (${result.target.skillKey}).` },
      };
    }
    const result = await quarantineSkillProposal(input);
    return {
      shouldContinue: false,
      reply: { text: `✅ Quarantined ${result.id} (${result.target.skillKey}).` },
    };
  } catch (error) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Skill Workshop command failed: ${formatErrorMessage(error)}` },
    };
  }
};
