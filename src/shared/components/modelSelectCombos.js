export async function loadModelSelectCombos(fetchImpl = fetch) {
  const response = await fetchImpl("/api/combos");
  if (!response.ok) throw new Error(`Failed to fetch combos: ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data.combos)) return [];

  // Untyped combos predate the kind field and are LLM combos by default.
  return data.combos.filter((combo) => !combo.kind || combo.kind === "llm");
}

export function toComboModelOption(combo) {
  return { id: combo.name, name: combo.name, value: combo.name };
}
