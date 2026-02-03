import { Type } from "@sinclair/typebox";
import { listSkills } from "../storage";
import { defineTool, toolError, toolSuccess } from "./types";

export const listSkillsTool = defineTool({
  name: "list_skills",
  label: "List Skills",
  description: "List installed Agent Skills with metadata (name and description). Does not return full SKILL.md bodies.",
  parameters: Type.Object({
    includeInactive: Type.Optional(
      Type.Boolean({
        description: "Include inactive skills. Default: true",
        default: true,
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    try {
      const skills = await listSkills();
      const filtered = params.includeInactive === false ? skills.filter((skill) => skill.enabled) : skills;
      const result = filtered.map((skill) => ({
        name: skill.name,
        description: skill.description,
        enabled: skill.enabled,
        allowedTools: skill.allowedTools ?? [],
        compatibility: skill.compatibility,
        metadata: skill.metadata ?? {},
      }));
      return toolSuccess(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to list skills";
      return toolError(message);
    }
  },
});
