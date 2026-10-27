const MAX_TEXT_LENGTH = 32_000;

function requireText(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`${field} exceeds the 32,000 character limit.`);
  return value;
}

export function activate(api) {
  api.registerTool({
    name: "text_metrics",
    description: "Count characters, words, non-empty lines, and paragraphs in supplied text. Read-only and deterministic.",
    execute(args = {}) {
      const text = requireText(args.text, "text");
      const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
      const lines = text ? text.split(/\r?\n/u).filter((line) => line.trim()).length : 0;
      const paragraphs = text.trim() ? text.trim().split(/\n\s*\n/u).length : 0;
      return { characters: Array.from(text).length, words, nonEmptyLines: lines, paragraphs };
    }
  });

  api.registerTool({
    name: "format_json",
    description: "Validate and pretty-print a supplied JSON string. Does not read or write files.",
    execute(args = {}) {
      const input = requireText(args.json, "json");
      let value;
      try { value = JSON.parse(input); }
      catch { throw new Error("Input is not valid JSON."); }
      const formatted = JSON.stringify(value, null, 2);
      if (formatted.length > MAX_TEXT_LENGTH) throw new Error("Formatted JSON exceeds the 32,000 character limit.");
      return { formatted };
    }
  });
}
