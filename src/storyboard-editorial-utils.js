import { createHash } from "node:crypto";
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function catalog(value, prefix = "P") {
  const rows = [];
  const visit = (v, path) => {
    if (typeof v === "string" && v.trim()) rows.push({id: `${prefix}${String(rows.length + 1).padStart(3, "0")}`, path, value: v});
    else if (v && typeof v === "object") for (const [key, child] of Object.entries(v)) visit(child, [...path, key]);
  };
  visit(value, []); return rows;
}
export function editable(entry) {
  const p = entry.path;
  if (["name", "speaker", "shotId"].includes(p.at(-1)) || p.includes("sourceSceneIds") || p.includes("source")) return false;
  if (p[0] === "shotPlan" && p.includes("characters")) return false;
  return ["viewingIntent", "visualDesign", "adaptations", "shotPlan"].includes(p[0]);
}
