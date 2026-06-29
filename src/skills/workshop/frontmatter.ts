import { normalizeSkillIndexName } from "../discovery/skill-index.js";
// Workshop frontmatter helpers parse generated skill metadata before saving drafts.
import { parseFrontmatter, resolveOpenClawMetadata } from "../loading/frontmatter.js";

type ProposalFrontmatter = {
  name: string;
  description: string;
};

const PROPOSAL_CONTENT_FORMAT = "skill-replacement-v2";
const PROPOSAL_METADATA_KEYS = [
  "name",
  "description",
  "status",
  "version",
  "date",
  "content-format",
];

// JSON strings are valid YAML scalars and avoid ad hoc escaping.
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Renders a live skill markdown document with the required name/description frontmatter. */
export function renderSkillMarkdown(params: {
  name: string;
  description: string;
  body: string;
  frontmatterExtra?: string;
}): string {
  const body = normalizeNewlines(params.body).replace(/^\n+/, "");
  const frontmatter = [
    `name: ${yamlScalar(params.name)}`,
    `description: ${yamlScalar(params.description)}`,
    ...(params.frontmatterExtra ? [normalizeNewlines(params.frontmatterExtra).trim()] : []),
  ]
    .filter(Boolean)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n${body}`;
}

/** Renders proposal markdown while preserving the full replacement skill markdown body. */
export function renderProposalMarkdown(params: {
  name: string;
  description: string;
  content: string;
  version?: string;
  date?: string;
}): string {
  const body = normalizeNewlines(params.content).replace(/^\n+/, "");
  const version = params.version ?? "v1";
  const date = params.date ?? new Date().toISOString();
  const frontmatter = [
    `name: ${yamlScalar(params.name)}`,
    `description: ${yamlScalar(params.description)}`,
    "status: proposal",
    `content-format: ${yamlScalar(PROPOSAL_CONTENT_FORMAT)}`,
    `version: ${yamlScalar(version)}`,
    `date: ${yamlScalar(date)}`,
  ].join("\n");
  return `---\n${frontmatter}\n---\n\n${body}`;
}

export function readProposalFrontmatter(content: string): ProposalFrontmatter | null {
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  const status = frontmatter.status?.trim().toLowerCase();
  if (!name || !description || status !== "proposal") {
    return null;
  }
  return { name, description };
}

export function stripProposalFrontmatterForSkill(content: string): string {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---")) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }

  const bodyStart = endIndex + "\n---".length;
  const body = normalized.slice(bodyStart).replace(/^\n+/, "");
  return body.endsWith("\n") ? body : `${body}\n`;
}

export function resolveAppliedSkillContent(content: string, expectedSkillKey?: string): string {
  const skillContent = stripProposalFrontmatterForSkill(content);
  try {
    assertValidAppliedSkillContent(skillContent, expectedSkillKey);
    return skillContent;
  } catch (error) {
    if (readProposalContentFormat(content) === PROPOSAL_CONTENT_FORMAT) {
      throw error;
    }
    const legacyContent = renderLegacyAppliedSkillContent(content);
    if (!legacyContent) {
      throw error;
    }
    assertValidAppliedSkillContent(legacyContent, expectedSkillKey);
    return legacyContent;
  }
}

/** Validates that proposal-stripped content is a writable live skill document. */
export function assertValidAppliedSkillContent(content: string, expectedSkillKey?: string): void {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---") || normalized.indexOf("\n---", 3) === -1) {
    throw new Error(
      "Proposal draft must contain a full replacement SKILL.md with name and description frontmatter.",
    );
  }
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!name || !description) {
    throw new Error(
      "Proposal draft must contain a full replacement SKILL.md with name and description frontmatter.",
    );
  }
  const metadataSkillKey = resolveOpenClawMetadata(frontmatter)?.skillKey;
  const candidateSkillKeys = [name, metadataSkillKey]
    .map((candidate) => (candidate ? normalizeSkillIndexName(candidate) : ""))
    .filter(Boolean);
  const normalizedExpectedSkillKey = expectedSkillKey
    ? normalizeSkillIndexName(expectedSkillKey)
    : "";
  if (normalizedExpectedSkillKey && !candidateSkillKeys.includes(normalizedExpectedSkillKey)) {
    throw new Error(
      `Proposal draft skill name does not match the target skill: expected ${expectedSkillKey}, got ${name}.`,
    );
  }
}

function normalizeNewlines(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function readProposalContentFormat(content: string): string | undefined {
  const frontmatter = parseFrontmatter(content);
  return frontmatter["content-format"]?.trim();
}

function renderLegacyAppliedSkillContent(content: string): string | null {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---")) {
    return null;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return null;
  }
  const frontmatter = parseFrontmatter(normalized);
  if (frontmatter.status?.trim().toLowerCase() !== "proposal") {
    return null;
  }
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  if (!name || !description) {
    return null;
  }
  const rawBlock = normalized.slice(4, endIndex);
  const frontmatterExtra = filterFrontmatterBlock(rawBlock, PROPOSAL_METADATA_KEYS);
  const body = normalized.slice(endIndex + "\n---".length).replace(/^\n+/, "");
  return renderSkillMarkdown({ name, description, body, frontmatterExtra });
}

function filterFrontmatterBlock(block: string, keysToDrop: readonly string[]): string {
  const drop = new Set(keysToDrop.map((key) => key.toLowerCase()));
  const kept: string[] = [];
  let dropping = false;

  for (const line of block.split("\n")) {
    const key = line.match(/^([\w-]+):/)?.[1]?.toLowerCase();
    if (key) {
      dropping = drop.has(key);
    }
    if (!dropping) {
      kept.push(line);
    }
  }

  return kept.join("\n").trim();
}
