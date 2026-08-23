const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("manifest and package metadata describe the same current release", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.name, "LingoLens");
  assert.equal(packageJson.name, "lingolens");
  assert.equal(manifest.action.default_title, "Open LingoLens");
  for (const permission of ["activeTab", "offscreen", "tabCapture"]) {
    assert.ok(manifest.permissions.includes(permission));
  }
  for (const host of ["https://api.deepseek.com/*", "https://api.deepgram.com/*"]) {
    assert.ok(manifest.host_permissions.includes(host));
  }
});

test("public documentation identifies the project and upstream origin", () => {
  const readme = read("README.md");
  const chineseReadme = read("README.zh-CN.md");
  assert.match(readme, /^# LingoLens$/m);
  assert.match(chineseReadme, /^# LingoLens$/m);
  assert.match(readme, /https:\/\/github\.com\/zarazhangrui\/youtube-digest/);
  assert.match(readme, /https:\/\/github\.com\/lhrcom\/LingoLens\/releases/);
  assert.match(chineseReadme, /https:\/\/github\.com\/lhrcom\/LingoLens\/releases/);
});

test("runtime and release files contain no source credential dependency", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const publicFiles = [
    "background.js",
    "content.js",
    "live-caption-background.js",
    "options.js",
    "sidepanel.js",
  ];
  const publicText = publicFiles.map(read).join("\n");
  assert.doesNotMatch(publicText, /sk-[A-Za-z0-9]{16,}/);
  assert.doesNotMatch(publicText, /config\.js/);
  assert.equal(manifest.version, "1.3.6");
});

test("published prompt files expose the runtime sections", () => {
  assert.match(read("prompts/analysis.md"), /^## System prompt$/m);
  assert.match(read("prompts/analysis.md"), /^## User prompt$/m);
  assert.match(read("prompts/translation.md"), /^## Transcript batch translation$/m);
});
