export function detectOutputNodeId(workflow: Record<string, unknown>): string | null {
  const outputClassTypes = ["SaveImage", "VHS_VideoCombine", "SaveVideo"];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const classType = (node as { class_type?: string }).class_type;
    if (classType && outputClassTypes.includes(classType)) {
      return nodeId;
    }
  }
  return null;
}

export function substitutePlaceholders(
  workflow: Record<string, unknown>,
  values: Record<string, string>,
): Record<string, unknown> {
  let json = JSON.stringify(workflow);
  for (const [key, value] of Object.entries(values)) {
    json = json.split(`{{${key}}}`).join(value);
  }
  return JSON.parse(json) as Record<string, unknown>;
}
