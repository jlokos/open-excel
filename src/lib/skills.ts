import { parse, stringify } from "yaml";

export type SkillSourceType = "url" | "paste" | "file" | "folder" | "builder";

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export interface SkillMetadata extends SkillFrontmatter {
  id: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  sourceType: SkillSourceType;
  source?: string;
}

export interface SkillFileEntry {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  mimeType?: string;
  size?: number;
}

export interface SkillPackage {
  metadata: SkillMetadata;
  files: SkillFileEntry[];
}

export interface SkillParseResult {
  frontmatter?: SkillFrontmatter;
  body?: string;
  errors: string[];
  warnings: string[];
}

export interface SkillPackageBuildResult {
  skill?: SkillPackage;
  errors: string[];
  warnings: string[];
}

export interface SkillBuilderInput {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  purpose?: string;
  whenToUse?: string;
  instructions?: string;
  inputs?: string;
  outputs?: string;
  tools?: string;
  examples?: string;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_LIMIT = 1024;
const COMPATIBILITY_LIMIT = 500;

export function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveNameFromSource(source: string): string | null {
  const safeSource = source.trim();
  if (!safeSource) return null;
  try {
    const url = new URL(safeSource);
    const segment = url.pathname.split("/").filter(Boolean).pop();
    if (segment) {
      return normalizeSkillName(segment.replace(/\.[^.]+$/, ""));
    }
  } catch {
    // Fallback to plain string parsing below.
  }
  const segment = safeSource.split("/").filter(Boolean).pop();
  if (!segment) return null;
  return normalizeSkillName(segment.replace(/\.[^.]+$/, ""));
}

export function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (!name) {
    errors.push("Skill name is required.");
    return errors;
  }
  if (name.length > 64) {
    errors.push("Skill name must be 1-64 characters.");
  }
  if (!NAME_PATTERN.test(name)) {
    errors.push(
      "Skill name must be lowercase, alphanumeric, hyphen-separated, with no leading/trailing hyphen or double hyphens.",
    );
  }
  return errors;
}

function parseAllowedTools(value: unknown): { allowedTools?: string[]; error?: string } {
  if (typeof value === "string") {
    const tools = value.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    return { allowedTools: tools.length > 0 ? tools : undefined };
  }
  if (Array.isArray(value)) {
    return { error: "allowed-tools must be a space-delimited string." };
  }
  return {};
}

function parseMetadata(value: unknown): { metadata?: Record<string, string>; errors: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { errors: [] };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return { errors: [] };
  const metadata: Record<string, string> = {};
  const errors: string[] = [];
  for (const [key, val] of entries) {
    if (typeof val !== "string") {
      errors.push("Metadata values must be strings.");
      continue;
    }
    metadata[String(key)] = val;
  }
  return { metadata, errors };
}

export function parseSkillMarkdown(content: string): SkillParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    errors.push("SKILL.md must start with YAML frontmatter delimited by ---.");
    return { errors, warnings };
  }

  let doc: unknown;
  try {
    doc = parse(match[1]);
  } catch (err) {
    errors.push(`Invalid YAML frontmatter: ${err instanceof Error ? err.message : "Parse error"}`);
    return { errors, warnings };
  }

  if (!doc || typeof doc !== "object") {
    errors.push("Frontmatter must be a YAML mapping.");
    return { errors, warnings };
  }

  const raw = doc as Record<string, unknown>;
  const parsedMetadata = parseMetadata(raw.metadata);
  if (raw.allowedTools && !raw["allowed-tools"]) {
    errors.push("Frontmatter must use 'allowed-tools' (not 'allowedTools').");
  }
  const parsedAllowed = parseAllowedTools(raw["allowed-tools"]);
  const frontmatter: SkillFrontmatter = {
    name: String(raw.name ?? "").trim(),
    description: String(raw.description ?? "").trim(),
    license: raw.license ? String(raw.license).trim() : undefined,
    compatibility: raw.compatibility ? String(raw.compatibility).trim() : undefined,
    metadata: parsedMetadata.metadata,
    allowedTools: parsedAllowed.allowedTools,
  };

  errors.push(...parsedMetadata.errors);
  if (parsedAllowed.error) errors.push(parsedAllowed.error);

  const validationErrors = validateSkillFrontmatter(frontmatter);
  errors.push(...validationErrors);

  const body = (match[2] ?? "").trim();
  const lineCount = body ? body.split(/\r?\n/).length : 0;
  if (lineCount > 500) {
    warnings.push("SKILL.md body exceeds 500 lines. Consider shortening for best results.");
  }

  return {
    frontmatter,
    body,
    errors,
    warnings,
  };
}

export function validateSkillFrontmatter(frontmatter: SkillFrontmatter, rootName?: string): string[] {
  const errors: string[] = [];
  errors.push(...validateSkillName(frontmatter.name));

  if (!frontmatter.description) {
    errors.push("Frontmatter description is required.");
  } else if (frontmatter.description.length > DESCRIPTION_LIMIT) {
    errors.push("Description must be 1-1024 characters.");
  }

  if (rootName && frontmatter.name && frontmatter.name !== rootName) {
    errors.push("Skill name must match the skill folder name.");
  }

  if (frontmatter.compatibility && frontmatter.compatibility.length > COMPATIBILITY_LIMIT) {
    errors.push("Compatibility must be 1-500 characters if provided.");
  }

  if (frontmatter.metadata) {
    for (const [key, value] of Object.entries(frontmatter.metadata)) {
      if (!key.trim() || !value.trim()) {
        errors.push("Metadata keys and values must be non-empty strings.");
        break;
      }
    }
  }

  return errors;
}

export function extractSkillName(content: string): string | null {
  const parsed = parseSkillMarkdown(content);
  if (parsed.frontmatter?.name) return parsed.frontmatter.name;
  return null;
}

export function findReferencedPaths(body: string): string[] {
  if (!body) return [];
  const matches = body.match(/\b(?:scripts|references|assets)\/[A-Za-z0-9._/-]+/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map((path) => path.trim())));
}

export function buildSkillMarkdown(input: SkillBuilderInput): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name.trim(),
    description: input.description.trim(),
  };
  if (input.license?.trim()) frontmatter.license = input.license.trim();
  if (input.compatibility?.trim()) frontmatter.compatibility = input.compatibility.trim();
  if (input.metadata && Object.keys(input.metadata).length > 0) frontmatter.metadata = input.metadata;
  if (input.allowedTools && input.allowedTools.length > 0) {
    frontmatter["allowed-tools"] = input.allowedTools.join(" ");
  }

  const yamlText = stringify(frontmatter).trim();

  const sections: string[] = [];
  sections.push(`# ${input.name.trim()}`);
  sections.push(`## Purpose\n${input.description.trim()}`);
  if (input.whenToUse?.trim()) sections.push(`## When to Use\n${input.whenToUse.trim()}`);
  if (input.instructions?.trim()) sections.push(`## Instructions\n${input.instructions.trim()}`);
  if (input.inputs?.trim()) sections.push(`## Inputs\n${input.inputs.trim()}`);
  if (input.outputs?.trim()) sections.push(`## Outputs\n${input.outputs.trim()}`);
  if (input.tools?.trim()) sections.push(`## Tools\n${input.tools.trim()}`);
  if (input.examples?.trim()) sections.push(`## Examples\n${input.examples.trim()}`);

  return `---\n${yamlText}\n---\n\n${sections.join("\n\n")}`.trim();
}

export function buildSkillPackageFromMarkdown(options: {
  content: string;
  sourceType: SkillSourceType;
  source?: string;
  enabled?: boolean;
  rootName?: string;
}): SkillPackageBuildResult {
  const parsed = parseSkillMarkdown(options.content);
  const errors = [...parsed.errors];
  const warnings = [...parsed.warnings];
  if (!parsed.frontmatter) {
    return { errors, warnings };
  }

  errors.push(...validateSkillFrontmatter(parsed.frontmatter, options.rootName));

  if (errors.length > 0) {
    return { errors, warnings };
  }

  const now = Date.now();
  const metadata: SkillMetadata = {
    id: parsed.frontmatter.name,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    license: parsed.frontmatter.license,
    compatibility: parsed.frontmatter.compatibility,
    metadata: parsed.frontmatter.metadata,
    allowedTools: parsed.frontmatter.allowedTools,
    enabled: options.enabled ?? false,
    createdAt: now,
    updatedAt: now,
    sourceType: options.sourceType,
    source: options.source?.trim() || undefined,
  };

  const files: SkillFileEntry[] = [
    {
      path: "SKILL.md",
      content: options.content,
      encoding: "utf-8",
      mimeType: "text/markdown",
      size: options.content.length,
    },
  ];

  return { skill: { metadata, files }, errors, warnings };
}
