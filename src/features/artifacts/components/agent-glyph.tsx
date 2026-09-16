/**
 * The agent's mark.
 *
 * Shared by the Timeline sidebar, the Session detail (timeline nodes and header
 * chip) and the grounded chat. The letter fallback matters: a plugin id we have
 * no mark for still has to render as *something* identifying.
 *
 * `mono` drops the brand tint and inherits the surrounding colour, which is how
 * the chat composer badges its agent.
 *
 * `size` is in pixels, because the callers want genuinely different marks: an
 * 11px chip glyph, and a 16px avatar on the detail's timeline rail where the
 * mark is what identifies the turn.
 */

import { AgentIcons, AgentMonogram, ExternalAgentIcon } from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { cn } from "@/lib/utils";

export function AgentGlyph({
  agent,
  mono,
  size = 11,
}: {
  agent: string;
  mono?: boolean;
  size?: number;
}) {
  const dim = { width: size, height: size };
  if (agent.includes("claude"))
    return (
      <AgentIcons.Claude style={dim} className={cn(!mono && "text-[var(--agent-claude-chip)]")} />
    );
  if (agent.includes("codex"))
    return (
      <AgentIcons.Codex style={dim} className={cn(!mono && "text-[var(--agent-codex-chip)]")} />
    );
  if (agent.includes("opencode"))
    return (
      <AgentIcons.OpenCode
        style={dim}
        className={cn(!mono && "text-[var(--agent-opencode-chip)]")}
      />
    );
  if (agent.includes("cursor"))
    return (
      <AgentIcons.Cursor style={dim} className={cn(!mono && "text-[var(--agent-cursor-chip)]")} />
    );
  if (agent.includes("kilo"))
    return <AgentIcons.Kilo style={dim} className={cn(!mono && "text-[var(--agent-kilo-chip)]")} />;
  if (agent.includes("cersei")) return <AtlasIcon size={size} className="rounded-[3px]" />;
  // Registry-installed external agent: manifest SVG, else a monogram.
  const meta = agentMeta(agent);
  if (meta.iconDataUrl) return <ExternalAgentIcon dataUrl={meta.iconDataUrl} size={size} />;
  return <AgentMonogram label={meta.label} size={size} />;
}
