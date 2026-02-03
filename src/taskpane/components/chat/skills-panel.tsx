import { FolderUp, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  buildSkillMarkdown,
  buildSkillPackageFromMarkdown,
  extractSkillName,
  findReferencedPaths,
  normalizeSkillName,
  type SkillFileEntry,
  type SkillSourceType,
  validateSkillName,
} from "../../../lib/skills";
import { useChat } from "./chat-context";

type SkillMode = "add" | "build";

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function toBulletList(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  return lines.map((line) => (line.startsWith("- ") ? line : `- ${line}`)).join("\n");
}

function buildSkillMarkdownFromForm(input: {
  name: string;
  description: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedTools: string[];
  whenToUse: string;
  instructions: string;
  tools: string;
  inputs: string;
  outputs: string;
  examples: string;
}): string {
  return buildSkillMarkdown({
    name: input.name.trim(),
    description: input.description.trim(),
    license: input.license.trim() || undefined,
    compatibility: input.compatibility.trim() || undefined,
    metadata: Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
    allowedTools: input.allowedTools,
    whenToUse: input.whenToUse.trim() || undefined,
    instructions: input.instructions.trim() ? toBulletList(input.instructions) : undefined,
    inputs: input.inputs.trim() ? toBulletList(input.inputs) : undefined,
    outputs: input.outputs.trim() ? toBulletList(input.outputs) : undefined,
    tools: input.tools.trim() ? toBulletList(input.tools) : undefined,
    examples: input.examples.trim() || undefined,
  });
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml") return true;
  const name = file.name.toLowerCase();
  return [".md", ".txt", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".yml", ".yaml"].some((ext) =>
    name.endsWith(ext),
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of Array.from(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function fileToEntry(file: File, path: string): Promise<SkillFileEntry> {
  if (isTextFile(file)) {
    const text = await file.text();
    return {
      path,
      content: text,
      encoding: "utf-8",
      mimeType: file.type || "text/plain",
      size: file.size,
    };
  }
  const buffer = await file.arrayBuffer();
  return {
    path,
    content: arrayBufferToBase64(buffer),
    encoding: "base64",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  };
}

export function SkillsPanel() {
  const { state, skills, upsertSkill, setSkillEnabled, removeSkill, loadSkillContent, buildSkillDraft } = useChat();

  const [mode, setMode] = useState<SkillMode>("add");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceType, setSourceType] = useState<SkillSourceType>("paste");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [folderError, setFolderError] = useState("");

  const [buildName, setBuildName] = useState("");
  const [buildDescription, setBuildDescription] = useState("");
  const [buildWhenToUse, setBuildWhenToUse] = useState("");
  const [buildInstructions, setBuildInstructions] = useState("");
  const [buildTools, setBuildTools] = useState("");
  const [buildInputs, setBuildInputs] = useState("");
  const [buildOutputs, setBuildOutputs] = useState("");
  const [buildExamples, setBuildExamples] = useState("");
  const [buildLicense, setBuildLicense] = useState("");
  const [buildCompatibility, setBuildCompatibility] = useState("");
  const [buildAllowedTools, setBuildAllowedTools] = useState("");
  const [buildMetadata, setBuildMetadata] = useState("");
  const [draft, setDraft] = useState("");
  const [buildLoading, setBuildLoading] = useState(false);
  const [buildError, setBuildError] = useState("");
  const [skillPreview, setSkillPreview] = useState<Record<string, string>>({});

  const enabledCount = useMemo(() => skills.filter((skill) => skill.enabled).length, [skills]);
  const detectedName = useMemo(() => (content ? extractSkillName(content) : null), [content]);
  const detectedNameErrors = useMemo(() => (detectedName ? validateSkillName(detectedName) : []), [detectedName]);

  const resetForm = () => {
    setSourceUrl("");
    setSourceLabel("");
    setSourceType("paste");
    setContent("");
    setError("");
    setWarnings([]);
    setFolderError("");
    setEditingId(null);
  };

  const resetBuilder = () => {
    setBuildName("");
    setBuildDescription("");
    setBuildWhenToUse("");
    setBuildInstructions("");
    setBuildTools("");
    setBuildInputs("");
    setBuildOutputs("");
    setBuildExamples("");
    setBuildLicense("");
    setBuildCompatibility("");
    setBuildAllowedTools("");
    setBuildMetadata("");
    setDraft("");
    setBuildError("");
  };

  const handleFetch = async () => {
    setError("");
    setWarnings([]);
    const url = sourceUrl.trim();
    if (!url) {
      setError("Enter a URL to fetch a SKILL.md file.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const text = await response.text();
      setContent(text);
      setSourceType("url");
      setSourceLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch skill.");
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (file: File | null) => {
    if (!file) return;
    setError("");
    setWarnings([]);
    try {
      const text = await file.text();
      setContent(text);
      setSourceType("file");
      setSourceUrl("");
      setSourceLabel(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read file.");
    }
  };

  const handleFolderImport = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setFolderError("");
    setWarnings([]);
    const grouped = new Map<string, { file: File; relativePath: string }[]>();

    Array.from(fileList).forEach((file) => {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const segments = rel.split("/").filter(Boolean);
      const root = segments[0] ?? "";
      const relativePath = segments.slice(1).join("/") || file.name;
      if (!root) return;
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root)?.push({ file, relativePath });
    });

    const errors: string[] = [];
    const warnings: string[] = [];

    for (const [root, entries] of Array.from(grouped.entries())) {
      const skillMdEntry = entries.find((entry) => entry.relativePath === "SKILL.md");
      if (!skillMdEntry) {
        errors.push(`Folder ${root} is missing SKILL.md.`);
        continue;
      }
      const skillMdText = await skillMdEntry.file.text();
      const result = buildSkillPackageFromMarkdown({
        content: skillMdText,
        sourceType: "folder",
        source: root,
        rootName: root,
        enabled: false,
      });

      if (!result.skill) {
        errors.push(`Folder ${root}: ${result.errors.join(" ")}`);
        warnings.push(...result.warnings);
        continue;
      }

      const fileEntries: SkillFileEntry[] = [...result.skill.files];
      const existingPaths = new Set(fileEntries.map((file) => file.path));

      for (const entry of entries) {
        if (entry.relativePath === "SKILL.md") continue;
        const normalizedPath = entry.relativePath.replace(/^\//, "");
        if (existingPaths.has(normalizedPath)) continue;
        const fileEntry = await fileToEntry(entry.file, normalizedPath);
        fileEntries.push(fileEntry);
        existingPaths.add(normalizedPath);
      }

      const referenced = findReferencedPaths(skillMdText);
      const missing = referenced.filter((path) => !existingPaths.has(path));
      if (missing.length > 0) {
        warnings.push(`Folder ${root}: missing referenced files (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}).`);
      }
      const deepPaths = Array.from(existingPaths).filter(
        (path) => path !== "SKILL.md" && path.split("/").length > 2,
      );
      if (deepPaths.length > 0) {
        warnings.push(`Folder ${root}: paths should be one level deep (found ${deepPaths.slice(0, 3).join(", ")}).`);
      }

      await upsertSkill({ metadata: result.skill.metadata, files: fileEntries });
    }

    if (errors.length > 0) {
      setFolderError(errors.join(" "));
    } else {
      resetForm();
    }
    if (warnings.length > 0) {
      setWarnings((prev) => [...prev, ...warnings]);
    }
  };

  const handleSubmit = async () => {
    setError("");
    setWarnings([]);
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      setError("Paste or fetch a SKILL.md file first.");
      return;
    }

    const hasUrl = Boolean(sourceUrl.trim());
    const normalizedSourceType: SkillSourceType = sourceType === "file" ? "file" : hasUrl ? "url" : "paste";
    const resolvedSource =
      normalizedSourceType === "url"
        ? sourceUrl.trim() || undefined
        : normalizedSourceType === "file"
          ? sourceLabel || undefined
          : undefined;

    const result = buildSkillPackageFromMarkdown({
      content: trimmedContent,
      sourceType: normalizedSourceType,
      source: resolvedSource,
      enabled: editingId ? skills.find((skill) => skill.id === editingId)?.enabled ?? false : false,
    });

    if (result.errors.length > 0 || !result.skill) {
      setError(result.errors.join(" "));
      setWarnings(result.warnings);
      return;
    }

    if (editingId && result.skill.metadata.id !== editingId) {
      setError("Skill name in frontmatter must match the existing skill name when editing.");
      return;
    }

    const nameErrors = validateSkillName(result.skill.metadata.name);
    if (nameErrors.length > 0) {
      setError(nameErrors.join(" "));
      return;
    }

    const nameCollision = skills.some((skill) => skill.id === result.skill?.metadata.id && skill.id !== editingId);
    if (nameCollision) {
      setError("A skill with this name already exists.");
      return;
    }

    const referenced = findReferencedPaths(result.skill.files.find((file) => file.path === "SKILL.md")?.content ?? "");
    if (referenced.length > 0) {
      setWarnings((prev) => [
        ...prev,
        `Referenced files not included: ${referenced.slice(0, 5).join(", ")}${referenced.length > 5 ? "…" : ""}`,
      ]);
    }

    try {
      await upsertSkill(result.skill);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save skill.");
    }
  };

  const handleBuildDraft = () => {
    setBuildError("");
    const normalizedName = normalizeSkillName(buildName);
    const nameErrors = validateSkillName(normalizedName);
    if (nameErrors.length > 0) {
      setBuildError(nameErrors.join(" "));
      return;
    }
    if (!buildDescription.trim()) {
      setBuildError("Description is required.");
      return;
    }
    if (buildDescription.trim().length > 1024) {
      setBuildError("Description must be 1-1024 characters.");
      return;
    }
    if (buildCompatibility.trim().length > 500) {
      setBuildError("Compatibility must be 1-500 characters.");
      return;
    }
    const metadata: Record<string, string> = {};
    buildMetadata
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const [key, ...rest] = line.split(":");
        if (!key || rest.length === 0) return;
        metadata[key.trim()] = rest.join(":").trim();
      });
    const allowedTools = buildAllowedTools
      .split(/\s+/)
      .map((tool) => tool.trim())
      .filter(Boolean);

    const nextDraft = buildSkillMarkdownFromForm({
      name: normalizedName,
      description: buildDescription,
      license: buildLicense,
      compatibility: buildCompatibility,
      metadata,
      allowedTools,
      whenToUse: buildWhenToUse,
      instructions: buildInstructions,
      tools: buildTools,
      inputs: buildInputs,
      outputs: buildOutputs,
      examples: buildExamples,
    });
    setBuildName(normalizedName);
    setDraft(nextDraft);
  };

  const handleGenerateWithAi = async () => {
    setBuildError("");
    if (!state.providerConfig) {
      setBuildError("Configure a provider in Settings to generate a draft with AI.");
      return;
    }
    setBuildLoading(true);
    try {
      const normalizedName = normalizeSkillName(buildName);
      const result = await buildSkillDraft({
        name: normalizedName || undefined,
        summary: buildDescription,
        whenToUse: buildWhenToUse,
        instructions: buildInstructions,
        tools: buildTools,
        inputs: buildInputs,
        outputs: buildOutputs,
        examples: buildExamples,
        license: buildLicense,
        compatibility: buildCompatibility,
        allowedTools: buildAllowedTools,
        metadata: buildMetadata,
      });
      setDraft(result);
      const inferred = extractSkillName(result);
      if (inferred) setBuildName(inferred);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Failed to generate draft.");
    } finally {
      setBuildLoading(false);
    }
  };

  const handleAddBuiltSkill = async () => {
    setBuildError("");
    const trimmedDraft = draft.trim();
    if (!trimmedDraft) {
      setBuildError("Generate or paste a draft first.");
      return;
    }
    const result = buildSkillPackageFromMarkdown({
      content: trimmedDraft,
      sourceType: "builder",
      source: "builder",
      enabled: false,
    });
    if (!result.skill || result.errors.length > 0) {
      setBuildError(result.errors.join(" "));
      return;
    }
    const nameErrors = validateSkillName(result.skill.metadata.name);
    if (nameErrors.length > 0) {
      setBuildError(nameErrors.join(" "));
      return;
    }
    const nameCollision = skills.some((skill) => skill.id === result.skill?.metadata.id);
    if (nameCollision) {
      setBuildError("A skill with this name already exists.");
      return;
    }
    try {
      await upsertSkill(result.skill);
      resetBuilder();
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Failed to save skill.");
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6" style={{ fontFamily: "var(--chat-font-mono)" }}>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-(--chat-text-muted) mb-2">agent skills</div>
        <p className="text-xs text-(--chat-text-secondary) leading-relaxed">
          Skill metadata is available to the model at all times. Activate a skill to load its full SKILL.md into the
          system prompt.
        </p>
        <p className="text-[10px] text-(--chat-text-muted) mt-2">
          Scripts and assets are stored for reference. The add-in does not execute skill scripts.
        </p>
        <p className="text-[10px] text-(--chat-text-muted) mt-2">
          Active: {enabledCount} / {skills.length}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("add")}
          className={`px-3 py-2 text-xs border ${
            mode === "add"
              ? "border-(--chat-accent) text-(--chat-text-primary)"
              : "border-(--chat-border) text-(--chat-text-muted) hover:text-(--chat-text-secondary)"
          }`}
          style={{ borderRadius: "var(--chat-radius)" }}
        >
          Add Skill
        </button>
        <button
          type="button"
          onClick={() => setMode("build")}
          className={`px-3 py-2 text-xs border ${
            mode === "build"
              ? "border-(--chat-accent) text-(--chat-text-primary)"
              : "border-(--chat-border) text-(--chat-text-muted) hover:text-(--chat-text-secondary)"
          }`}
          style={{ borderRadius: "var(--chat-radius)" }}
        >
          Build Skill
        </button>
      </div>

      {mode === "add" ? (
        <div
          className="border border-(--chat-border) bg-(--chat-bg-secondary) p-3 space-y-3"
          style={{ borderRadius: "var(--chat-radius)" }}
        >
          <div className="text-[10px] uppercase tracking-widest text-(--chat-text-muted)">add skill</div>

          <div className="space-y-2">
            <span className="block text-xs text-(--chat-text-secondary)">Import Skill Folder</span>
            <label className="text-xs text-(--chat-text-secondary) cursor-pointer inline-flex items-center gap-2">
              <input
                type="file"
                multiple
                // @ts-expect-error webkitdirectory is nonstandard but supported in Chromium WebView
                webkitdirectory="true"
                className="hidden"
                onChange={(e) => handleFolderImport(e.target.files)}
              />
              <span
                className="inline-flex items-center gap-2 px-3 py-2 border border-(--chat-border) hover:border-(--chat-border-active) transition-colors"
                style={{ borderRadius: "var(--chat-radius)" }}
              >
                <FolderUp size={12} />
                Upload Folder
              </span>
            </label>
            <p className="text-[10px] text-(--chat-text-muted)">
              Folder root must match the SKILL.md frontmatter name.
            </p>
            {folderError && <p className="text-[11px] text-(--chat-error)">{folderError}</p>}
          </div>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">SKILL.md URL (optional)</span>
            <div className="flex gap-2">
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/.../SKILL.md"
                className="flex-1 bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-sm px-3 py-2 border border-(--chat-border)
                           placeholder:text-(--chat-text-muted)
                           focus:outline-none focus:border-(--chat-border-active)"
                style={{ borderRadius: "var(--chat-radius)" }}
              />
              <button
                type="button"
                onClick={handleFetch}
                disabled={loading}
                className={`px-3 py-2 text-xs border transition-colors ${
                  loading
                    ? "text-(--chat-text-muted) border-(--chat-border) cursor-not-allowed"
                    : "text-(--chat-text-secondary) border-(--chat-border) hover:border-(--chat-border-active)"
                }`}
                style={{ borderRadius: "var(--chat-radius)" }}
              >
                {loading ? "Fetching..." : "Fetch"}
              </button>
            </div>
          </label>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">SKILL.md content</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              placeholder="Paste the full SKILL.md file here"
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          {content.trim() && (
            <div className="text-[10px] text-(--chat-text-muted)">
              Detected name: {detectedName ?? "Not found"}
              {!detectedName && <span className="text-(--chat-error)"> — YAML frontmatter required</span>}
              {detectedNameErrors.length > 0 && (
                <span className="text-(--chat-error)"> — {detectedNameErrors.join(" ")}</span>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-(--chat-text-secondary) cursor-pointer">
              <input
                type="file"
                accept=".md,.txt"
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files?.[0] ?? null)}
              />
              <span
                className="inline-flex items-center gap-2 px-3 py-2 border border-(--chat-border) hover:border-(--chat-border-active) transition-colors"
                style={{ borderRadius: "var(--chat-radius)" }}
              >
                Upload SKILL.md
              </span>
            </label>

            <div className="flex items-center gap-2">
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-3 py-2 text-xs border border-(--chat-border) text-(--chat-text-secondary) hover:border-(--chat-border-active)"
                  style={{ borderRadius: "var(--chat-radius)" }}
                >
                  Cancel
                </button>
              )}
                <button
                  type="button"
                  onClick={handleSubmit}
                  className="flex items-center gap-2 px-3 py-2 text-xs border border-(--chat-accent) bg-(--chat-accent) text-white hover:bg-(--chat-accent-hover)"
                  style={{ borderRadius: "var(--chat-radius)" }}
                >
                  <Plus size={12} />
                  {editingId ? "Save Skill" : "Add Skill"}
                </button>
              </div>
            </div>

          {error && <p className="text-[11px] text-(--chat-error)">{error}</p>}
          {warnings.length > 0 && (
            <div className="text-[11px] text-(--chat-text-muted)">
              {warnings.map((warning, idx) => (
                <p key={`${warning}-${idx}`}>{warning}</p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          className="border border-(--chat-border) bg-(--chat-bg-secondary) p-3 space-y-3"
          style={{ borderRadius: "var(--chat-radius)" }}
        >
          <div className="text-[10px] uppercase tracking-widest text-(--chat-text-muted)">build skill</div>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Skill name</span>
            <input
              type="text"
              value={buildName}
              onChange={(e) => setBuildName(normalizeSkillName(e.target.value))}
              placeholder="e.g. sales-forecast"
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-sm px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
            <p className="text-[10px] text-(--chat-text-muted) mt-1">Lowercase letters, numbers, and hyphens only.</p>
          </label>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Description</span>
            <textarea
              value={buildDescription}
              onChange={(e) => setBuildDescription(e.target.value)}
              rows={2}
              placeholder="One or two sentences describing the skill."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <div className="grid gap-2">
            <label className="block">
              <span className="block text-xs text-(--chat-text-secondary) mb-1.5">License (optional)</span>
              <input
                type="text"
                value={buildLicense}
                onChange={(e) => setBuildLicense(e.target.value)}
                placeholder="MIT, Apache-2.0, etc."
                className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-xs px-3 py-2 border border-(--chat-border)
                           placeholder:text-(--chat-text-muted)
                           focus:outline-none focus:border-(--chat-border-active)"
                style={{ borderRadius: "var(--chat-radius)" }}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Compatibility (optional)</span>
              <input
                type="text"
                value={buildCompatibility}
                onChange={(e) => setBuildCompatibility(e.target.value)}
                placeholder="Compatibility notes (optional)."
                className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-xs px-3 py-2 border border-(--chat-border)
                           placeholder:text-(--chat-text-muted)
                           focus:outline-none focus:border-(--chat-border-active)"
                style={{ borderRadius: "var(--chat-radius)" }}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Allowed tools (optional)</span>
              <input
                type="text"
                value={buildAllowedTools}
                onChange={(e) => setBuildAllowedTools(e.target.value)}
                placeholder="space-separated tool names"
                className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-xs px-3 py-2 border border-(--chat-border)
                           placeholder:text-(--chat-text-muted)
                           focus:outline-none focus:border-(--chat-border-active)"
                style={{ borderRadius: "var(--chat-radius)" }}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Metadata (optional)</span>
              <textarea
                value={buildMetadata}
                onChange={(e) => setBuildMetadata(e.target.value)}
                rows={2}
                placeholder="key: value (one per line)"
                className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                           text-xs px-3 py-2 border border-(--chat-border)
                           placeholder:text-(--chat-text-muted)
                           focus:outline-none focus:border-(--chat-border-active)"
                style={{ borderRadius: "var(--chat-radius)" }}
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">When to use</span>
            <textarea
              value={buildWhenToUse}
              onChange={(e) => setBuildWhenToUse(e.target.value)}
              rows={2}
              placeholder="When this skill should be applied."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Instructions / rules</span>
            <textarea
              value={buildInstructions}
              onChange={(e) => setBuildInstructions(e.target.value)}
              rows={4}
              placeholder="One rule per line."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Inputs (optional)</span>
            <textarea
              value={buildInputs}
              onChange={(e) => setBuildInputs(e.target.value)}
              rows={2}
              placeholder="Expected inputs or context."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Outputs (optional)</span>
            <textarea
              value={buildOutputs}
              onChange={(e) => setBuildOutputs(e.target.value)}
              rows={2}
              placeholder="Expected outputs."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Tools (optional)</span>
            <textarea
              value={buildTools}
              onChange={(e) => setBuildTools(e.target.value)}
              rows={2}
              placeholder="Tools or capabilities the skill can use."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">Examples (optional)</span>
            <textarea
              value={buildExamples}
              onChange={(e) => setBuildExamples(e.target.value)}
              rows={3}
              placeholder="Example prompts or expected responses."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleBuildDraft}
              className="flex items-center gap-2 px-3 py-2 text-xs border border-(--chat-border) text-(--chat-text-secondary) hover:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              <Wand2 size={12} />
              Build Draft
            </button>
            <button
              type="button"
              onClick={handleGenerateWithAi}
              disabled={buildLoading}
              className={`flex items-center gap-2 px-3 py-2 text-xs border ${
                buildLoading
                  ? "border-(--chat-border) text-(--chat-text-muted) cursor-not-allowed"
                  : "border-(--chat-accent) text-(--chat-accent) hover:border-(--chat-accent-hover)"
              }`}
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              <Sparkles size={12} />
              {buildLoading ? "Generating..." : "Generate with AI"}
            </button>
            <button
              type="button"
              onClick={resetBuilder}
              className="px-3 py-2 text-xs border border-(--chat-border) text-(--chat-text-secondary) hover:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              Reset
            </button>
          </div>
          <p className="text-[10px] text-(--chat-text-muted)">
            Generate with AI uses the provider/model configured in Settings.
          </p>

          <label className="block">
            <span className="block text-xs text-(--chat-text-secondary) mb-1.5">SKILL.md draft</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              placeholder="Generated SKILL.md will appear here."
              className="w-full bg-(--chat-input-bg) text-(--chat-text-primary)
                         text-xs px-3 py-2 border border-(--chat-border)
                         placeholder:text-(--chat-text-muted)
                         focus:outline-none focus:border-(--chat-border-active)"
              style={{ borderRadius: "var(--chat-radius)" }}
            />
          </label>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleAddBuiltSkill}
              className="flex items-center gap-2 px-3 py-2 text-xs border border-(--chat-accent) bg-(--chat-accent) text-white hover:bg-(--chat-accent-hover)"
              style={{ borderRadius: "var(--chat-radius)" }}
            >
              <Plus size={12} />
              Add Built Skill
            </button>
          </div>

          {buildError && <p className="text-[11px] text-(--chat-error)">{buildError}</p>}
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-widest text-(--chat-text-muted) mb-2">installed skills</div>
        {skills.length === 0 ? (
          <p className="text-xs text-(--chat-text-muted)">No skills installed yet.</p>
        ) : (
          <div className="space-y-3">
            {skills.map((skill) => (
              <div
                key={skill.id}
                className="border border-(--chat-border) bg-(--chat-bg-secondary) p-3 space-y-2"
                style={{ borderRadius: "var(--chat-radius)" }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-(--chat-text-primary) truncate">{skill.name}</div>
                    <div className="text-[11px] text-(--chat-text-secondary) truncate">{skill.description}</div>
                    {skill.allowedTools && skill.allowedTools.length > 0 && (
                      <div className="text-[10px] text-(--chat-text-muted) truncate">
                        Allowed tools: {skill.allowedTools.join(" ")}
                      </div>
                    )}
                    {skill.source && (
                      <div className="text-[10px] text-(--chat-text-muted) truncate">Source: {skill.source}</div>
                    )}
                    <div className="text-[10px] text-(--chat-text-muted)">Updated: {formatTimestamp(skill.updatedAt)}</div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSkillEnabled(skill.id, !skill.enabled)}
                      className={`
                        w-10 h-5 rounded-full transition-colors relative
                        ${skill.enabled ? "bg-(--chat-accent)" : "bg-(--chat-border)"}
                      `}
                    >
                      <span
                        className={`
                          absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform
                          ${skill.enabled ? "left-5" : "left-0.5"}
                        `}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        setMode("add");
                        setEditingId(skill.id);
                        setError("");
                        setWarnings([]);
                        const urlSource = skill.sourceType === "url" ? skill.source ?? "" : "";
                        const fileSource = skill.sourceType === "file" ? skill.source ?? "" : "";
                        setSourceType(urlSource ? "url" : fileSource ? "file" : "paste");
                        setSourceUrl(urlSource);
                        setSourceLabel(fileSource);
                        let skillContent: string | null = null;
                        try {
                          skillContent = await loadSkillContent(skill.id);
                        } catch {
                          skillContent = null;
                        }
                        if (skillContent && skillContent.trim().length > 0) {
                          setContent(skillContent);
                        } else {
                          setContent("");
                          setError(
                            urlSource
                              ? "Failed to load SKILL.md content for editing. Click Fetch to reload from the source URL."
                              : "Failed to load SKILL.md content for editing. Re-import the skill to restore it.",
                          );
                        }
                      }}
                      className="text-xs text-(--chat-text-secondary) hover:text-(--chat-text-primary)"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeSkill(skill.id)}
                      className="p-1 text-(--chat-text-muted) hover:text-(--chat-error)"
                      title="Remove skill"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                <details
                  className="text-xs text-(--chat-text-secondary)"
                  onToggle={async (event) => {
                    const target = event.currentTarget;
                    if (!target.open || skillPreview[skill.id]) return;
                    let skillContent: string | null = null;
                    try {
                      skillContent = await loadSkillContent(skill.id);
                    } catch {
                      skillContent = null;
                    }
                    const previewContent =
                      skillContent && skillContent.trim().length > 0
                        ? skillContent
                        : "Failed to load SKILL.md content.";
                    setSkillPreview((prev) => ({ ...prev, [skill.id]: previewContent }));
                  }}
                >
                  <summary className="cursor-pointer text-(--chat-text-secondary) hover:text-(--chat-text-primary)">
                    View SKILL.md
                  </summary>
                  <pre
                    className="mt-2 whitespace-pre-wrap text-[11px] text-(--chat-text-secondary) bg-(--chat-bg) border border-(--chat-border) p-2 overflow-x-auto"
                    style={{ borderRadius: "var(--chat-radius)" }}
                  >
                    {skillPreview[skill.id] ?? "Loading..."}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
