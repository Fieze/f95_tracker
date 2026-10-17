const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

// The app is English-only for now. This guards against German strings creeping back into the UI,
// notifications, dialogs and error messages (source code only, not tests or docs).
const GERMAN_WORDS = /\b(beenden|verf(?:ü|ue)gbar|gefunden|installiert|bitte|fehler|einstellungen|öffnen|schließen|abbrechen|speichern|löschen|herunterladen|spiele?|ordner|datei|wurde|werden|nicht|keine?|und|oder|noch|neue|neuer|eine?|beobachtetes?|bereit|wird)\b/i;

async function* walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|html)$/.test(entry.name)) yield full;
  }
}

test("user-facing source text contains no German words", async () => {
  const offenders = [];
  for await (const file of walk(path.resolve(__dirname, "..", "src"))) {
    const text = await fs.readFile(file, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      // Only string literals and markup text matter; skip pure comment lines.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      const literals = line.match(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|>[^<>\n]+</g) || [];
      for (const literal of literals) {
        if (GERMAN_WORDS.test(literal)) offenders.push(`${path.relative(path.resolve(__dirname, ".."), file)}:${index + 1}: ${literal.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
