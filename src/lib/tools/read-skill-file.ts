import { Type } from "@sinclair/typebox";
import { getSkillByName, getSkillFile } from "../storage";
import { defineTool, toolError, toolSuccess } from "./types";

export const readSkillFileTool = defineTool({
  name: "read_skill_file",
  label: "Read Skill File",
  description: "Read a file from a skill directory (references, scripts, or assets).",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name (must match SKILL.md frontmatter name)" }),
    path: Type.String({ description: "Relative path inside the skill folder, e.g. references/context.md" }),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const skill = await getSkillByName(params.name);
      if (!skill) {
        return toolError(`Skill not found: ${params.name}`);
      }
      const file = await getSkillFile(skill.id, params.path);
      if (!file) {
        return toolError(`File not found: ${params.path}`);
      }
      return toolSuccess({
        name: skill.name,
        path: file.path,
        encoding: file.encoding,
        mimeType: file.mimeType,
        content: file.content,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read skill file";
      return toolError(message);
    }
  },
});
