---
name: release
description: Create a release, publish to npm, and create a GitHub release. Use when asked to "release", "cut a release", "publish", "bump version", "create release", "npm publish".
---

# Release

Create a versioned release: bump version, update changelog, publish to npm, tag, push, and create a GitHub release.

## Step 1: Determine Version

Check the current version and latest git tag:

```bash
cat package.json | grep '"version"'
git tag -l --sort=-v:refname | head -5
```

If the user provided a version, use it. Otherwise ask:

> What version? (current is X.Y.Z — patch/minor/major, or exact version)

Resolve semver:
- `patch` → X.Y.(Z+1)
- `minor` → X.(Y+1).0
- `major` → (X+1).0.0
- Exact version string → use as-is

## Step 2: Generate Changelog

Get commits since the last tag (or all commits if no tags exist):

```bash
# If tags exist:
git log $(git tag -l --sort=-v:refname | head -1)..HEAD --pretty=format:"- %s" --no-merges

# If no tags:
git log --pretty=format:"- %s" --no-merges
```

Group commits by type using conventional commit prefixes:

| Prefix | Section |
|--------|---------|
| `feat` | ✨ Features |
| `fix` | 🐛 Bug Fixes |
| `refactor` | ♻️ Refactoring |
| `docs` | 📝 Documentation |
| `chore`, `test`, `perf`, `ci` | 🔧 Other Changes |
| No prefix | 🔧 Other Changes |

Format as markdown. Omit empty sections. Strip the `type(scope):` prefix from each line for readability.

**Always start the changelog with this install block** (hardcoded):

````markdown
Install:

```bash
npm install glimpseui@<VERSION>
```

Pi agent package:

```bash
pi install npm:glimpseui@<VERSION>
```
````

Then add the grouped commit sections below it.

## Step 3: Update CHANGELOG.md

Replace the `## Unreleased` section (if present) with `## <VERSION>`, or add a new `## <VERSION>` section at the top. The content should match the generated changelog sections (without the install block — that's for GitHub releases only).

## Step 4: Update package.json

Bump the version in `package.json`:

```bash
# Use a precise edit to change only the version field
```

## Step 5: Commit and Tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): v<VERSION>"
git tag v<VERSION>
```

## Step 6: Publish to npm

Run the publish script which handles preflight checks (clean tree, main branch, npm auth, build, tests):

```bash
./scripts/publish.sh
```

**Important:** The publish script checks for a clean working tree and runs build + tests. Since we already committed in Step 5, the tree should be clean. The script will prompt for confirmation — answer `y`.

If `publish.sh` also tags (it does), skip the `git tag` in Step 5 to avoid duplicate tags. Check the script behavior first.

**Alternative** (if the script flow conflicts): publish manually after the commit:

```bash
npm run build
npm test
npm publish
git tag v<VERSION>
```

## Step 7: Push

```bash
git push && git push --tags
```

## Step 8: Create GitHub Release

```bash
gh release create v<VERSION> --title "v<VERSION>" --notes "<CHANGELOG>"
```

Pass the generated changelog (with install block) as the `--notes` value. Use a temp file if the changelog is long:

```bash
echo "<CHANGELOG>" > /tmp/release-notes.md
gh release create v<VERSION> --title "v<VERSION>" --notes-file /tmp/release-notes.md
rm /tmp/release-notes.md
```

## Step 9: Verify

Confirm the release was created:

```bash
gh release view v<VERSION>
```

Print a summary:

```
✅ Released glimpseui@<VERSION>
   npm: https://www.npmjs.com/package/glimpseui
   Tag: v<VERSION>
   URL: https://github.com/HazAT/glimpse/releases/tag/v<VERSION>
```
