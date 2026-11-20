import { api } from "$lib/api";
import type { SkillDoc } from "$lib/api/shared/skills";

/** The skill the viewer popup shows (`?view=skill:<id>`): its row and SKILL.md from GET /api/skills/doc, read once per id it opens. */
class SkillView {
  id = $state<string | null>(null);
  doc = $state<SkillDoc | null>(null);
  error = $state<string | null>(null);

  load(id: string): void {
    if (this.id === id && (this.doc || this.error)) return;
    this.id = id;
    this.doc = null;
    this.error = null;
    api.skillDoc(id).then(
      doc => {
        if (this.id === id) this.doc = doc;
      },
      (reason: unknown) => {
        if (this.id === id) this.error = reason instanceof Error ? reason.message : String(reason);
      },
    );
  }

  /** The popup's title and the line under it for the skill `id`, before and after its doc reads. */
  title(id: string): string {
    return this.id === id && this.doc ? this.doc.row.name : "Skill";
  }

  description(id: string): string {
    const row = this.id === id ? this.doc?.row : null;
    return row ? `${row.kind} on ${row.box}` : "";
  }
}

export const skillView = new SkillView();
