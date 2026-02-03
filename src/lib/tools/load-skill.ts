import { Type } from "@sinclair/typebox";
import { getSkillFile, getSkillByName } from "../storage";
import { defineTool, toolError, toolSuccess } from "./types";

function decodeContent(content: string, encoding: "utf-8" | "base64"): string {
  if (encoding === "base64") {
    try {
      return atob(content);
    } catch {
      return "";
    }
  }
  return content;
}

export const loadSkillTool = defineTool({
  name: "load_skill",
  label: "Load Skill",
  description: "Load the full SKILL.md content for a specific skill by name.",
  parameters: Type.Object({
    name: Type.String({ description: "Skill name (must match SKILL.md frontmatter name)" }),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const skill = await getSkillByName(params.name);
      if (!skill) {
        return toolError(`Skill not found: ${params.name}`);
      }
      const file = await getSkillFile(skill.id, "SKILL.md");
      if (!file) {
        return toolError(`SKILL.md not found for skill: ${params.name}`);
      }
      const content = decodeContent(file.content, file.encoding);
      return toolSuccess({
        name: skill.name,
        description: skill.description,
        content,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load skill";
      return toolError(message);
    }
  },
});
